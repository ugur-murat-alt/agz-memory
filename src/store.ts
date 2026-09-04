import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import {
  cleanProjectName,
  normalizeProjectName,
  validateProjectName,
} from "./project";
import { INLINE_LIMIT, KINDS, PREDICATES } from "./types";
import { hashTuple, noteContentHash } from "./hash";
import { deriveDocument } from "./retrieval/derived";
import { LIMITS, assertTextLimit } from "./contracts/limits";
import { decodeCursor, encodeCursor, paginate } from "./contracts/pagination";
import { assertStrictMutationOperation, type MutationOperation } from "./contracts/mutation";
import type {
  Edge,
  Kind,
  Note,
  Predicate,
  Project,
  ProjectSummary,
  RecallCard,
} from "./types";

export interface ProjectSelector {
  projectID?: string;
  projectName?: string;
}

export interface UpdateResult {
  ok: boolean;
  id?: string;
  projectID?: string;
  projectName?: string;
  reason?: string;
  sizeClass?: string;
  deleted?: boolean;
}

export class MemoryStore {
  constructor(
    private db: Database,
    private indexBackends: readonly string[] = [],
  ) {}

  resolveProject(selector: ProjectSelector): {
    ok: boolean;
    project?: Project;
    reason?: string;
  } {
    const row = selector.projectID
      ? this.getProjectRow(selector.projectID)
      : selector.projectName
        ? (this.db
            .query("SELECT * FROM projects WHERE normalized_name = ?")
            .get(normalizeProjectName(selector.projectName)) as
            ProjectRow | undefined)
        : undefined;
    if (!row) {
      const reference =
        selector.projectID ?? selector.projectName ?? "missing selector";
      return { ok: false, reason: `project ${reference} not found` };
    }
    return { ok: true, project: rowToProject(row) };
  }

  listProjects(): ProjectSummary[] {
    const rows = this.db
      .query(
        `SELECT p.*,
                COUNT(n.id) AS note_count,
                COALESCE(SUM(CASE WHEN n.pinned = 1 THEN 1 ELSE 0 END), 0) AS pinned_count
           FROM projects p
           LEFT JOIN notes n ON n.project_id = p.id
          GROUP BY p.id
          ORDER BY p.normalized_name`,
      )
      .all() as Array<
      ProjectRow & { note_count: number; pinned_count: number }
    >;
    return rows.map((row) => ({
      ...rowToProject(row),
      noteCount: row.note_count,
      pinnedCount: row.pinned_count,
    }));
  }

  listProjectsPage(limit: number, cursor?: string, snapshot?: string) {
    const projects = this.listProjects();
    const current = hashTuple(
      "project-list-snapshot",
      1,
      projects.flatMap((project) => [
        project.projectID,
        project.projectName,
        project.createdAt,
        project.updatedAt,
        project.noteCount,
        project.pinnedCount,
      ]),
    );
    return paginate(projects, { projectID: "__projects__", query: "", limit, cursor, snapshot: current, requestedSnapshot: snapshot });
  }

  createProject(nameValue: string): {
    ok: boolean;
    project?: Project;
    reason?: string;
  } {
    const reason = validateProjectName(nameValue);
    if (reason) return { ok: false, reason };
    const name = cleanProjectName(nameValue);
    const normalizedName = normalizeProjectName(name);
    if (this.projectNameExists(normalizedName)) {
      return { ok: false, reason: `project name already exists: ${name}` };
    }
    const id = randomUUID();
    const now = Date.now();
    try {
      const row = this.immediateTransaction(
        () =>
          this.db
            .query(
              "INSERT INTO projects (id, name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
            )
            .get(id, name, normalizedName, now, now) as ProjectRow | undefined,
      );
      if (!row) throw new Error("project insert returned no row");
      return { ok: true, project: rowToProject(row) };
    } catch (error) {
      const committed = this.getProjectByNormalizedName(normalizedName);
      if (committed) {
        return {
          ok: false,
          reason: `project name already exists: ${committed.name}`,
        };
      }
      throw error;
    }
  }

  updateProject(
    projectID: string,
    nameValue: string,
  ): { ok: boolean; project?: Project; reason?: string } {
    const existing = this.getProjectRow(projectID);
    if (!existing)
      return { ok: false, reason: `project ${projectID} not found` };
    const reason = validateProjectName(nameValue);
    if (reason) return { ok: false, reason };
    const name = cleanProjectName(nameValue);
    const normalizedName = normalizeProjectName(name);
    if (existing.name === name) {
      return { ok: true, project: rowToProject(existing) };
    }
    if (this.projectNameExists(normalizedName, projectID)) {
      return { ok: false, reason: `project name already exists: ${name}` };
    }
    const now = Date.now();
    try {
      const updated = this.immediateTransaction(
        () =>
          this.db
            .query(
              `UPDATE projects
                  SET name = ?,
                      normalized_name = ?,
                      updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
                WHERE id = ?
                RETURNING *`,
            )
            .get(name, normalizedName, now, now, projectID) as
            ProjectRow | undefined,
      );
      if (!updated)
        return { ok: false, reason: `project ${projectID} not found` };
      return { ok: true, project: rowToProject(updated) };
    } catch (error) {
      const committed = this.getProjectByNormalizedName(normalizedName);
      if (committed && committed.id !== projectID) {
        return {
          ok: false,
          reason: `project name already exists: ${committed.name}`,
        };
      }
      throw error;
    }
  }

  deleteProject(
    projectID: string,
    confirmProjectName: string,
  ): {
    ok: boolean;
    deleted?: boolean;
    projectID?: string;
    projectName?: string;
    deletedCounts?: { notes: number; edges: number; pinned: number };
    reason?: string;
  } {
    const initialProject = this.getProjectRow(projectID);
    if (!initialProject)
      return { ok: false, reason: `project ${projectID} not found` };
    if (confirmProjectName !== initialProject.name) {
      return {
        ok: false,
        reason:
          "confirmProjectName must exactly match the current project name",
      };
    }

    return this.immediateTransaction(() => {
      const project = this.getProjectRow(projectID);
      if (!project)
        return { ok: false, reason: `project ${projectID} not found` };
      if (project.name !== confirmProjectName) {
        return {
          ok: false,
          reason:
            "confirmProjectName must exactly match the current project name",
        };
      }
      const counts = this.db
        .query(
          `SELECT
             (SELECT COUNT(*) FROM notes WHERE project_id = ?) AS notes,
             (SELECT COUNT(*) FROM note_edges WHERE project_id = ?) AS edges,
             (SELECT COUNT(*) FROM notes WHERE project_id = ? AND pinned = 1) AS pinned`,
        )
        .get(projectID, projectID, projectID) as {
        notes: number;
        edges: number;
        pinned: number;
      };
      const now = Date.now();
      for (const backend of this.indexBackends) {
        this.enqueueOutbox(
          backend,
          "purge-project",
          project.id,
          null,
          null,
          null,
          now,
        );
      }
      const deleted = this.db
        .query(
          "DELETE FROM projects WHERE id = ? AND name = ? RETURNING id, name",
        )
        .get(projectID, confirmProjectName) as DeletedProjectRow | undefined;
      if (!deleted)
        return {
          ok: false,
          reason:
            "confirmProjectName must exactly match the current project name",
        };
      return {
        ok: true,
        deleted: true,
        projectID: deleted.id,
        projectName: deleted.name,
        deletedCounts: counts,
      };
    });
  }

  update(projectID: string, operation: MutationOperation): UpdateResult {
    const project = this.getProjectRow(projectID);
    if (!project)
      return { ok: false, reason: `project ${projectID} not found` };
    assertStrictMutationOperation(operation);
    if (operation.operation === "delete") {
      const id = operation.id;
      assertTextLimit("noteID", id);
      const existing = this.getNoteRow(projectID, id);
      if (!existing)
        return {
          ok: false,
          reason: `note ${id} not found in project ${project.name}`,
        };
      return this.immediateTransaction(() => {
        const deleted = this.db
          .query(
            "DELETE FROM notes WHERE project_id = ? AND id = ? AND status = 'active' RETURNING *",
          )
          .get(projectID, id) as NoteStorageRow | undefined;
        if (!deleted) {
          const current = this.getNoteRow(projectID, id);
          return current
            ? { ok: false, reason: `note is ${current.status}` }
            : {
                ok: false,
                reason: `note ${id} not found in project ${project.name}`,
              };
        }
        const now = Date.now();
        this.bumpProjectVersion(projectID, now);
        for (const backend of this.indexBackends) {
          this.enqueueOutbox(
            backend,
            "delete-note",
            deleted.project_id,
            deleted.id,
            deleted.current_revision,
            null,
            now,
          );
        }
        return {
          ok: true,
          id: deleted.id,
          projectID,
          projectName: project.name,
          deleted: true,
        };
      });
    }

    if (operation.operation === "patch") assertTextLimit("noteID", operation.id);
    const existing = operation.operation === "patch"
      ? this.getNoteRow(projectID, operation.id)
      : undefined;
    if (operation.operation === "patch" && !existing) {
      return {
        ok: false,
        reason: `note ${operation.id} not found in project ${project.name}`,
      };
    }
    if (existing && existing.status !== "active") {
      return { ok: false, reason: `note is ${existing.status}` };
    }

    const changes = operation.operation === "patch" ? operation.changes : undefined;
    const kindValue = operation.operation === "create" ? operation.kind : changes?.kind ?? existing?.kind;
    const kind = (KINDS as readonly string[]).includes(kindValue ?? "")
      ? (kindValue as Kind)
      : null;
    if (!kind)
      return { ok: false, reason: `kind must be one of: ${KINDS.join(", ")}` };
    const title = operation.operation === "create"
      ? operation.title.trim()
      : changes?.title === undefined ? existing?.title ?? "" : changes.title.trim();
    const summary = operation.operation === "create"
      ? operation.summary.trim()
      : changes?.summary === undefined ? existing?.summary ?? "" : changes.summary.trim();
    const content = operation.operation === "create"
      ? (operation.content ?? summary).trim()
      : changes?.content === undefined ? existing?.content ?? summary : changes.content.trim();
    if (!title) return { ok: false, reason: "title is required" };
    if (!summary) return { ok: false, reason: "summary is required" };
    if (!content) return { ok: false, reason: "content is empty" };
    assertTextLimit("title", title);
    assertTextLimit("summary", summary);
    assertTextLimit("content", content);

    const now = Date.now();
    const sizeClass = content.length <= INLINE_LIMIT ? "inline" : "indexed";
    const contentHash = noteContentHash(kind, title, summary, content);
    if (existing) {
      if (
        existing.kind === kind &&
        existing.title === title &&
        existing.summary === summary &&
        existing.content === content &&
        existing.size_class === sizeClass
      ) {
        const unchanged = this.immediateTransaction(() =>
          this.db
            .query(
              `SELECT * FROM notes
                WHERE project_id = ? AND id = ? AND current_revision = ? AND status = 'active'
                  AND kind = ? AND title = ? AND summary = ? AND content = ? AND size_class = ?`,
            )
            .get(
              projectID,
              existing.id,
              existing.current_revision,
              kind,
              title,
              summary,
              content,
              sizeClass,
            ) as NoteStorageRow | undefined,
        );
        if (!unchanged) {
          return {
            ok: false,
            id: existing.id,
            projectID,
            projectName: project.name,
            reason: "revision_conflict",
          };
        }
        return {
          ok: true,
          id: existing.id,
          projectID,
          projectName: project.name,
          sizeClass,
        };
      }
      const subjectKey =
        existing.kind === kind && existing.title === title
          ? existing.subject_key
          : null;
      const committed = this.immediateTransaction(() => {
        const updated = this.db
          .query(
            `UPDATE notes
                SET kind = ?, title = ?, summary = ?, content = ?, size_class = ?, subject_key = ?,
                    current_revision = current_revision + 1, content_hash = ?, updated_at = ?
              WHERE project_id = ? AND id = ? AND current_revision = ? AND status = 'active'
              RETURNING *`,
          )
          .get(
            kind,
            title,
            summary,
            content,
            sizeClass,
            subjectKey,
            contentHash,
            now,
            projectID,
            existing.id,
            existing.current_revision,
          ) as NoteStorageRow | undefined;
        if (!updated) return undefined;
        this.bumpProjectVersion(projectID, now);
        this.recordCurrentRevision(updated, "mcp-manual", now);
        const derived = deriveDocument({
          projectID: updated.project_id,
          noteID: updated.id,
          revision: updated.current_revision,
          kind: updated.kind,
          title: updated.title,
          summary: updated.summary,
          content: updated.content,
        });
        if (derived) {
          for (const backend of this.indexBackends) {
            this.enqueueOutbox(
              backend,
              "upsert-note",
              updated.project_id,
              updated.id,
              updated.current_revision,
              derived.contentHash,
              now,
            );
          }
        }
        return updated;
      });
      if (!committed) {
        return {
          ok: false,
          id: existing.id,
          projectID,
          projectName: project.name,
          reason: "revision_conflict",
        };
      }
      return {
        ok: true,
        id: committed.id,
        projectID,
        projectName: project.name,
        sizeClass: committed.size_class,
      };
    }
    const id = randomUUID();
    const committed = this.insertNote(
      id,
      projectID,
      kind,
      title,
      summary,
      content,
      sizeClass,
      null,
      null,
      now,
    );
    return {
      ok: true,
      id: committed.id,
      projectID,
      projectName: project.name,
      sizeClass: committed.size_class,
    };
  }

  pin(projectID: string, id: string, pinned: boolean) {
    assertTextLimit("noteID", id);
    const project = this.getProjectRow(projectID);
    if (!project)
      return { ok: false, reason: `project ${projectID} not found` };
    const note = this.getNoteRow(projectID, id);
    if (!note)
      return {
        ok: false,
        reason: `note ${id} not found in project ${project.name}`,
      };
    if (note.status !== "active")
      return { ok: false, reason: `note is ${note.status}` };
    if (note.pinned === (pinned ? 1 : 0)) {
      const unchanged = this.immediateTransaction(() =>
        this.db
          .query(
            `SELECT * FROM notes
              WHERE project_id = ? AND id = ? AND current_revision = ?
                AND status = 'active' AND pinned = ?`,
          )
          .get(projectID, id, note.current_revision, pinned ? 1 : 0) as
          NoteStorageRow | undefined,
      );
      if (!unchanged) {
        return {
          ok: false,
          id,
          projectID,
          projectName: project.name,
          reason: "revision_conflict",
        };
      }
      return { ok: true, id, projectID, projectName: project.name, pinned };
    }
    const now = Date.now();
    const committed = this.immediateTransaction(() => {
      const updated = this.db
        .query(
          `UPDATE notes
              SET pinned = ?, current_revision = current_revision + 1, updated_at = ?
            WHERE project_id = ? AND id = ? AND current_revision = ? AND status = 'active'
            RETURNING *`,
        )
        .get(pinned ? 1 : 0, now, projectID, id, note.current_revision) as
        NoteStorageRow | undefined;
      if (!updated) return undefined;
      this.bumpProjectVersion(projectID, now);
      this.recordCurrentRevision(updated, "mcp-manual", now);
      const derived = deriveDocument({
        projectID: updated.project_id,
        noteID: updated.id,
        revision: updated.current_revision,
        kind: updated.kind,
        title: updated.title,
        summary: updated.summary,
        content: updated.content,
      });
      if (derived) {
        for (const backend of this.indexBackends) {
          this.enqueueOutbox(
            backend,
            "upsert-note",
            updated.project_id,
            updated.id,
            updated.current_revision,
            derived.contentHash,
            now,
          );
        }
      }
      return updated;
    });
    if (!committed) {
      return {
        ok: false,
        id,
        projectID,
        projectName: project.name,
        reason: "revision_conflict",
      };
    }
    return {
      ok: true,
      id: committed.id,
      projectID,
      projectName: project.name,
      pinned: committed.pinned === 1,
    };
  }

  private insertNote(
    id: string,
    projectID: string,
    kind: Kind,
    title: string,
    summary: string,
    content: string,
    sizeClass: string,
    supersedesID: string | null,
    subjectKey: string | null,
    now: number,
  ): NoteStorageRow {
    const contentHash = noteContentHash(kind, title, summary, content);
    return this.immediateTransaction(() => {
      const note = this.db
        .query(
          `INSERT INTO notes
             (id, project_id, kind, title, summary, content, size_class, pinned, status,
              supersedes_id, current_revision, subject_key, content_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, 1, ?, ?, ?, ?)
           RETURNING *`,
        )
        .get(
          id,
          projectID,
          kind,
          title,
          summary,
          content,
          sizeClass,
          supersedesID,
          subjectKey,
          contentHash,
          now,
          now,
        ) as NoteStorageRow | undefined;
      if (!note) throw new Error(`note ${id} insert returned no row`);
      this.bumpProjectVersion(projectID, now);
      this.recordCurrentRevision(note, "mcp-manual", now);
      const derived = deriveDocument({
        projectID: note.project_id,
        noteID: note.id,
        revision: note.current_revision,
        kind: note.kind,
        title: note.title,
        summary: note.summary,
        content: note.content,
      });
      if (derived) {
        for (const backend of this.indexBackends) {
          this.enqueueOutbox(
            backend,
            "upsert-note",
            note.project_id,
            note.id,
            note.current_revision,
            derived.contentHash,
            now,
          );
        }
      }
      return note;
    });
  }

  read(
    projectID: string,
    id: string,
  ): { note?: Note; edges?: Edge[]; snapshot?: string; etag?: string; nextCursor?: string; reason?: string } {
    const page = this.readPage(projectID, id, LIMITS.pageSize);
    if (!("note" in page)) return page;
    return {
      note: page.note,
      edges: page.items,
      snapshot: page.snapshot,
      etag: page.etag,
      nextCursor: page.nextCursor,
    };
  }

  readPage(projectID: string, id: string, limit: number, cursor?: string, snapshot?: string) {
    assertTextLimit("noteID", id);
    const row = this.getNoteRow(projectID, id);
    if (!row) return { reason: `note ${id} not found in project ${projectID}` };
    const edges = this.db
      .query(
        `SELECT e.id, e.project_id, p.name AS project_name, e.source_id, e.target_id, e.predicate, e.created_at
            FROM note_edges e
            JOIN projects p ON p.id = e.project_id
           WHERE e.project_id = ? AND (e.source_id = ? OR e.target_id = ?)
           ORDER BY e.created_at, e.id`,
      )
      .all(projectID, id, id) as Array<EdgeRow>;
    const resultEdges = edges.map(rowToEdge);
    const current = hashTuple(
      "note-edge-snapshot",
      1,
      [id, row.updated_at, ...resultEdges.flatMap((edge) => [edge.id, edge.projectID, edge.projectName, edge.sourceID, edge.targetID, edge.predicate, edge.createdAt])],
    );
    return {
      note: rowToNote(row),
      ...paginate(resultEdges, { projectID, query: `edges:${id}`, limit, cursor, snapshot: current, requestedSnapshot: snapshot }),
    };
  }

  listRevisionsPage(projectID: string, noteID: string, limit: number, cursor?: string, snapshot?: string) {
    assertTextLimit("noteID", noteID);
    const rows = this.db.query("SELECT revision, created_at FROM note_revisions WHERE project_id = ? AND note_id = ? ORDER BY revision").all(projectID, noteID) as Array<{ revision: number; created_at: number }>;
    const current = hashTuple("note-revision-snapshot", 1, [noteID, ...rows.flatMap((row) => [row.revision, row.created_at])]);
    return paginate(rows, { projectID, query: `revisions:${noteID}`, limit, cursor, snapshot: current, requestedSnapshot: snapshot });
  }

  link(
    projectID: string,
    sourceID: string,
    targetID: string,
    predicate: string,
  ) {
    assertTextLimit("noteID", sourceID);
    assertTextLimit("noteID", targetID);
    const project = this.getProjectRow(projectID);
    if (!project)
      return { ok: false, reason: `project ${projectID} not found` };
    if (!(PREDICATES as readonly string[]).includes(predicate)) {
      return {
        ok: false,
        reason: `predicate must be one of: ${PREDICATES.join(", ")}`,
      };
    }
    if (sourceID === targetID)
      return { ok: false, reason: "cannot link a note to itself" };
    for (const id of [sourceID, targetID]) {
      const row = this.getNoteRow(projectID, id);
      if (!row)
        return {
          ok: false,
          reason: `note ${id} not found in project ${project.name}`,
        };
      if (row.status !== "active")
        return { ok: false, reason: `note ${id} is ${row.status}` };
    }
    this.immediateTransaction(() => {
      const now = Date.now();
      const inserted = this.db
        .query(
          "INSERT OR IGNORE INTO note_edges (id, project_id, source_id, target_id, predicate, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(randomUUID(), projectID, sourceID, targetID, predicate as Predicate, now);
      if (inserted.changes > 0) this.bumpProjectVersion(projectID, now);
    });
    return { ok: true, projectID, projectName: project.name };
  }

  recall(projectID: string, query: string, limit = 10): RecallCard[] {
    return this.recallPage(projectID, query, limit).cards;
  }

  recallPage(projectID: string, query: string, limit: number = LIMITS.pageSize, cursor?: string, snapshot?: string) {
    assertTextLimit("query", query);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      return { cards: [], snapshot: hashTuple("recall-snapshot", 1, [projectID, query]), etag: hashTuple("recall-snapshot", 1, [projectID, query]) };
    }
    const pageLimit = Math.min(limit, LIMITS.pageSize);
    const tokens = query
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .slice(0, 12)
      .map((token) => `"${token.replace(/"/g, '""')}"`);
    if (tokens.length === 0) {
      const current = hashTuple("recall-snapshot", 1, [projectID, query]);
      return { cards: [], snapshot: current, etag: current };
    }
    const project = this.getProjectRow(projectID);
    const current = hashTuple("recall-snapshot", 2, [
      projectID,
      query,
      project?.name ?? "",
      project?.updated_at ?? 0,
    ]);
    if (snapshot !== undefined && snapshot !== current) throw new TypeError("stale_snapshot");
    const offset = cursor !== undefined
      ? decodeCursor(cursor, { projectID, query, snapshot: current }).offset
      : 0;
    const directCount = (this.db.query(
      `SELECT COUNT(*) AS count
         FROM notes_fts
         JOIN notes n ON n.rowid = notes_fts.rowid
        WHERE notes_fts MATCH ? AND n.project_id = ? AND n.status = 'active'`,
    ).get(tokens.join(" OR "), projectID) as { count: number }).count;
    const matches = offset < directCount ? this.db
      .query(
        `SELECT n.*, p.name AS project_name, bm25(notes_fts) AS rank
           FROM notes_fts
           JOIN notes n ON n.rowid = notes_fts.rowid
           JOIN projects p ON p.id = n.project_id
          WHERE notes_fts MATCH ? AND n.project_id = ? AND n.status = 'active'
           ORDER BY n.pinned DESC, rank, n.id
            LIMIT ? OFFSET ?`,
      )
      .all(tokens.join(" OR "), projectID, pageLimit, offset) as Array<
      NoteRow & { rank: number }
    > : [];

    const cards = matches.map((row) => toCard(rowToNote(row), "match"));
    const directRemaining = Math.max(0, directCount - offset);
    const neighborOffset = Math.max(0, offset - directCount);
    if (cards.length < pageLimit && directRemaining <= cards.length) {
      const firstMatches = this.db.query(
        `SELECT n.*, p.name AS project_name, bm25(notes_fts) AS rank
           FROM notes_fts
           JOIN notes n ON n.rowid = notes_fts.rowid
           JOIN projects p ON p.id = n.project_id
          WHERE notes_fts MATCH ? AND n.project_id = ? AND n.status = 'active'
          ORDER BY n.pinned DESC, rank, n.id
          LIMIT 5`,
      ).all(tokens.join(" OR "), projectID) as Array<NoteRow & { rank: number }>;
      const neighborsToAppend: RecallCard[] = [];
      const seen = new Set<string>();
      for (const match of firstMatches) {
      const neighbors = this.db
        .query(
          `SELECT e.predicate, n.*, p.name AS project_name
             FROM note_edges e
             JOIN notes n ON n.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END
             JOIN projects p ON p.id = n.project_id
            WHERE e.project_id = ?
              AND (e.source_id = ? OR e.target_id = ?)
              AND n.project_id = ?
              AND n.status = 'active'
             ORDER BY n.pinned DESC, n.updated_at DESC, n.id
            LIMIT 6`,
        )
        .all(match.id, projectID, match.id, match.id, projectID) as Array<
        NoteRow & { predicate: string }
      >;
      for (const neighbor of neighbors) {
        if (seen.has(neighbor.id)) continue;
        const isDirectMatch = this.db.query(
          `SELECT 1
             FROM notes_fts
             JOIN notes n ON n.rowid = notes_fts.rowid
            WHERE notes_fts MATCH ? AND n.project_id = ? AND n.id = ? AND n.status = 'active'`,
        ).get(tokens.join(" OR "), projectID, neighbor.id);
        if (isDirectMatch) continue;
        seen.add(neighbor.id);
        const card = toCard(rowToNote(neighbor), "neighbor");
        card.predicates = [neighbor.predicate];
        neighborsToAppend.push(card);
      }
    }
      cards.push(...neighborsToAppend.slice(neighborOffset, neighborOffset + (pageLimit - cards.length)));
      const consumedNeighbors = neighborOffset + Math.max(0, cards.length - matches.length);
      const hasMore = offset + matches.length < directCount || consumedNeighbors < neighborsToAppend.length;
      return {
        cards,
        snapshot: current,
        etag: current,
        ...(hasMore ? { nextCursor: encodeCursor({ projectID, query, snapshot: current, offset: offset + cards.length }) } : {}),
      };
    }
    const hasMore = offset + cards.length < directCount;
    return {
      cards,
      snapshot: current,
      etag: current,
      ...(hasMore ? { nextCursor: encodeCursor({ projectID, query, snapshot: current, offset: offset + cards.length }) } : {}),
    };
  }

  private getProjectRow(id: string): ProjectRow | undefined {
    return this.db.query("SELECT * FROM projects WHERE id = ?").get(id) as
      ProjectRow | undefined;
  }

  private bumpProjectVersion(projectID: string, now: number): void {
    this.db.query(
      `UPDATE projects
          SET updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END
        WHERE id = ?`,
    ).run(now, now, projectID);
  }

  private getProjectByNormalizedName(
    normalizedName: string,
  ): ProjectRow | undefined {
    return this.db
      .query("SELECT * FROM projects WHERE normalized_name = ?")
      .get(normalizedName) as ProjectRow | undefined;
  }

  private projectNameExists(
    normalizedName: string,
    excludingID?: string,
  ): boolean {
    const row = excludingID
      ? this.db
          .query(
            "SELECT id FROM projects WHERE normalized_name = ? AND id != ?",
          )
          .get(normalizedName, excludingID)
      : this.db
          .query("SELECT id FROM projects WHERE normalized_name = ?")
          .get(normalizedName);
    return Boolean(row);
  }

  private getNoteRow(projectID: string, id: string): NoteRow | undefined {
    return this.db
      .query(
        `SELECT n.*, p.name AS project_name
           FROM notes n
           JOIN projects p ON p.id = n.project_id
          WHERE n.project_id = ? AND n.id = ?`,
      )
      .get(projectID, id) as NoteRow | undefined;
  }

  private recordCurrentRevision(
    note: NoteStorageRow,
    sourceType: "mcp-manual" | "opencode-capture" | "admin",
    now: number,
  ): string {
    const provenanceID = randomUUID();
    this.db
      .query(
        `
      INSERT INTO note_provenance
        (id, project_id, note_id, source_type, capture_event_id, source_session_id,
         source_message_id, source_ordinal, source_tool_call_id, redaction_version,
         extractor_version, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        provenanceID,
        note.project_id,
        note.id,
        sourceType,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        now,
      );
    this.db
      .query(
        `
      INSERT INTO note_revisions
        (project_id, note_id, revision, kind, title, summary, content, size_class,
         pinned, status, supersedes_id, subject_key, content_hash, provenance_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        note.project_id,
        note.id,
        note.current_revision,
        note.kind,
        note.title,
        note.summary,
        note.content,
        note.size_class,
        note.pinned,
        note.status,
        note.supersedes_id,
        note.subject_key,
        note.content_hash,
        provenanceID,
        now,
      );
    return provenanceID;
  }

  private enqueueOutbox(
    backend: string,
    operation: "upsert-note" | "delete-note" | "purge-project",
    projectID: string,
    noteID: string | null,
    revision: number | null,
    contentHash: string | null,
    now: number,
  ): void {
    if (
      (operation === "upsert-note" &&
        (!noteID ||
          revision === null ||
          revision < 1 ||
          !contentHash ||
          !isHash(contentHash))) ||
      (operation === "delete-note" &&
        (!noteID ||
          revision === null ||
          revision < 1 ||
          contentHash !== null)) ||
      (operation === "purge-project" &&
        (noteID !== null || revision !== null || contentHash !== null))
    ) {
      throw new Error("invalid_outbox_row");
    }
    const generation = 0;
    const operationKey = hashTuple("outbox-operation", 2, [
      backend,
      operation,
      projectID,
      noteID,
      revision,
      contentHash,
      generation,
    ]);
    this.db
      .query(
        `
      INSERT INTO index_outbox
        (backend, operation_key, operation, project_id, note_id, revision, content_hash,
         generation, lease_generation, fence, state, attempt_count, available_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'pending', 0, ?, ?)
    `,
      )
      .run(
        backend,
        operationKey,
        operation,
        projectID,
        noteID,
        revision,
        contentHash,
        generation,
        now,
        now,
      );
  }

  private immediateTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original mutation error if rollback also fails.
      }
      throw error;
    }
  }
}

interface ProjectRow {
  id: string;
  name: string;
  normalized_name: string;
  created_at: number;
  updated_at: number;
}

interface NoteStorageRow {
  id: string;
  project_id: string;
  kind: Kind;
  title: string;
  summary: string;
  content: string;
  size_class: "inline" | "indexed";
  pinned: number;
  status: "active" | "superseded" | "archived";
  supersedes_id: string | null;
  current_revision: number;
  subject_key: string | null;
  content_hash: string;
  created_at: number;
  updated_at: number;
}

interface NoteRow extends NoteStorageRow {
  project_name: string;
}

interface DeletedProjectRow {
  id: string;
  name: string;
}

interface EdgeRow {
  id: string;
  project_id: string;
  project_name: string;
  source_id: string;
  target_id: string;
  predicate: Predicate;
  created_at: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    projectID: row.id,
    projectName: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    projectID: row.project_id,
    projectName: row.project_name,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    content: row.content,
    sizeClass: row.size_class,
    pinned: row.pinned === 1,
    status: row.status,
    supersedesID: row.supersedes_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEdge(row: EdgeRow): Edge {
  return {
    id: row.id,
    projectID: row.project_id,
    projectName: row.project_name,
    sourceID: row.source_id,
    targetID: row.target_id,
    predicate: row.predicate,
    createdAt: row.created_at,
  };
}

function toCard(note: Note, via: "match" | "neighbor"): RecallCard {
  return {
    id: note.id,
    projectID: note.projectID,
    projectName: note.projectName,
    kind: note.kind,
    title: note.title,
    summary: note.summary,
    content: note.sizeClass === "inline" ? note.content : undefined,
    sizeClass: note.sizeClass,
    pinned: note.pinned,
    via,
  };
}

function isHash(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}
