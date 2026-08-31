import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { cleanProjectName, normalizeProjectName, validateProjectName } from "./project";
import { INLINE_LIMIT, KINDS, PREDICATES } from "./types";
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

export interface UpdateInput {
  kind?: string;
  title?: string;
  summary?: string;
  content?: string;
  id?: string;
  delete?: boolean;
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
  constructor(private db: Database) {}

  resolveProject(selector: ProjectSelector): { ok: boolean; project?: Project; reason?: string } {
    const row = selector.projectID
      ? this.getProjectRow(selector.projectID)
      : selector.projectName
        ? (this.db
            .query("SELECT * FROM projects WHERE normalized_name = ?")
            .get(normalizeProjectName(selector.projectName)) as ProjectRow | undefined)
        : undefined;
    if (!row) {
      const reference = selector.projectID ?? selector.projectName ?? "missing selector";
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
      .all() as Array<ProjectRow & { note_count: number; pinned_count: number }>;
    return rows.map((row) => ({
      ...rowToProject(row),
      noteCount: row.note_count,
      pinnedCount: row.pinned_count,
    }));
  }

  createProject(nameValue: string): { ok: boolean; project?: Project; reason?: string } {
    const reason = validateProjectName(nameValue);
    if (reason) return { ok: false, reason };
    const name = cleanProjectName(nameValue);
    const normalizedName = normalizeProjectName(name);
    if (this.projectNameExists(normalizedName)) {
      return { ok: false, reason: `project name already exists: ${name}` };
    }
    const id = randomUUID();
    const now = Date.now();
    this.db.query(
      "INSERT INTO projects (id, name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, name, normalizedName, now, now);
    return { ok: true, project: { projectID: id, projectName: name, createdAt: now, updatedAt: now } };
  }

  updateProject(projectID: string, nameValue: string): { ok: boolean; project?: Project; reason?: string } {
    const existing = this.getProjectRow(projectID);
    if (!existing) return { ok: false, reason: `project ${projectID} not found` };
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
    this.db
      .query("UPDATE projects SET name = ?, normalized_name = ?, updated_at = ? WHERE id = ?")
      .run(name, normalizedName, now, projectID);
    return {
      ok: true,
      project: { projectID, projectName: name, createdAt: existing.created_at, updatedAt: now },
    };
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
    const project = this.getProjectRow(projectID);
    if (!project) return { ok: false, reason: `project ${projectID} not found` };
    if (confirmProjectName !== project.name) {
      return { ok: false, reason: "confirmProjectName must exactly match the current project name" };
    }

    const counts = this.db
      .query(
        `SELECT
           (SELECT COUNT(*) FROM notes WHERE project_id = ?) AS notes,
           (SELECT COUNT(*) FROM note_edges WHERE project_id = ?) AS edges,
           (SELECT COUNT(*) FROM notes WHERE project_id = ? AND pinned = 1) AS pinned`,
      )
      .get(projectID, projectID, projectID) as { notes: number; edges: number; pinned: number };

    this.db.transaction(() => {
      this.db
        .query("DELETE FROM notes_fts WHERE id IN (SELECT id FROM notes WHERE project_id = ?)")
        .run(projectID);
      this.db.query("DELETE FROM note_edges WHERE project_id = ?").run(projectID);
      this.db.query("DELETE FROM notes WHERE project_id = ?").run(projectID);
      this.db.query("DELETE FROM projects WHERE id = ?").run(projectID);
    })();
    return {
      ok: true,
      deleted: true,
      projectID,
      projectName: project.name,
      deletedCounts: counts,
    };
  }

  update(projectID: string, input: UpdateInput): UpdateResult {
    const project = this.getProjectRow(projectID);
    if (!project) return { ok: false, reason: `project ${projectID} not found` };
    if (input.delete) {
      if (!input.id) return { ok: false, reason: "id is required for delete" };
      const id = input.id;
      const existing = this.getNoteRow(projectID, id);
      if (!existing) return { ok: false, reason: `note ${id} not found in project ${project.name}` };
      this.db.transaction(() => {
        this.db
          .query("DELETE FROM note_edges WHERE project_id = ? AND (source_id = ? OR target_id = ?)")
          .run(projectID, id, id);
        this.db.query("DELETE FROM notes_fts WHERE id = ?").run(id);
        this.db.query("DELETE FROM notes WHERE project_id = ? AND id = ?").run(projectID, id);
      })();
      return { ok: true, id, projectID, projectName: project.name, deleted: true };
    }

    const existing = input.id ? this.getNoteRow(projectID, input.id) : undefined;
    if (input.id && !existing) {
      return { ok: false, reason: `note ${input.id} not found in project ${project.name}` };
    }
    if (existing && existing.status !== "active") {
      return { ok: false, reason: `note is ${existing.status}` };
    }

    const kindValue = input.kind ?? existing?.kind;
    const kind = (KINDS as readonly string[]).includes(kindValue ?? "") ? (kindValue as Kind) : null;
    if (!kind) return { ok: false, reason: `kind must be one of: ${KINDS.join(", ")}` };
    const title = (input.title ?? existing?.title ?? "").trim();
    const summary = (input.summary ?? existing?.summary ?? "").trim();
    const content = (input.content ?? existing?.content ?? summary).trim();
    if (!title) return { ok: false, reason: "title is required" };
    if (title.length > 240) return { ok: false, reason: "title exceeds 240 characters" };
    if (!summary) return { ok: false, reason: "summary is required" };
    if (!content) return { ok: false, reason: "content is empty" };

    const now = Date.now();
    const sizeClass = content.length <= INLINE_LIMIT ? "inline" : "indexed";
    if (existing) {
      this.db.transaction(() => {
        this.db.query(
          "UPDATE notes SET kind = ?, title = ?, summary = ?, content = ?, size_class = ?, updated_at = ? WHERE project_id = ? AND id = ?",
        ).run(kind, title, summary, content, sizeClass, now, projectID, existing.id);
        this.db.query("DELETE FROM notes_fts WHERE id = ?").run(existing.id);
        this.db
          .query("INSERT INTO notes_fts (id, title, summary, content) VALUES (?, ?, ?, ?)")
          .run(existing.id, title, summary, content);
      })();
      return { ok: true, id: existing.id, projectID, projectName: project.name, sizeClass };
    }
    const id = randomUUID();
    this.insertNote(id, projectID, kind, title, summary, content, sizeClass, null, now);
    return { ok: true, id, projectID, projectName: project.name, sizeClass };
  }

  pin(projectID: string, id: string, pinned: boolean) {
    const project = this.getProjectRow(projectID);
    if (!project) return { ok: false, reason: `project ${projectID} not found` };
    const note = this.getNoteRow(projectID, id);
    if (!note) return { ok: false, reason: `note ${id} not found in project ${project.name}` };
    if (note.status !== "active") return { ok: false, reason: `note is ${note.status}` };
    if (note.pinned === (pinned ? 1 : 0)) {
      return { ok: true, id, projectID, projectName: project.name, pinned };
    }
    this.db
      .query("UPDATE notes SET pinned = ?, updated_at = ? WHERE project_id = ? AND id = ?")
      .run(pinned ? 1 : 0, Date.now(), projectID, id);
    return { ok: true, id, projectID, projectName: project.name, pinned };
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
    now: number,
  ) {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO notes (id, project_id, kind, title, summary, content, size_class, pinned, status, supersedes_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)`,
        )
        .run(id, projectID, kind, title, summary, content, sizeClass, supersedesID, now, now);
      this.db
        .query("INSERT INTO notes_fts (id, title, summary, content) VALUES (?, ?, ?, ?)")
        .run(id, title, summary, content);
    })();
  }

  read(projectID: string, id: string): { note?: Note; edges?: Edge[]; reason?: string } {
    const row = this.getNoteRow(projectID, id);
    if (!row) return { reason: `note ${id} not found in project ${projectID}` };
    const edges = this.db
      .query(
        `SELECT e.id, e.project_id, p.name AS project_name, e.source_id, e.target_id, e.predicate, e.created_at
           FROM note_edges e
           JOIN projects p ON p.id = e.project_id
          WHERE e.project_id = ? AND (e.source_id = ? OR e.target_id = ?)`,
      )
      .all(projectID, id, id) as Array<EdgeRow>;
    return {
      note: rowToNote(row),
      edges: edges.map(rowToEdge),
    };
  }

  link(projectID: string, sourceID: string, targetID: string, predicate: string) {
    const project = this.getProjectRow(projectID);
    if (!project) return { ok: false, reason: `project ${projectID} not found` };
    if (!(PREDICATES as readonly string[]).includes(predicate)) {
      return { ok: false, reason: `predicate must be one of: ${PREDICATES.join(", ")}` };
    }
    if (sourceID === targetID) return { ok: false, reason: "cannot link a note to itself" };
    for (const id of [sourceID, targetID]) {
      const row = this.getNoteRow(projectID, id);
      if (!row) return { ok: false, reason: `note ${id} not found in project ${project.name}` };
      if (row.status !== "active") return { ok: false, reason: `note ${id} is ${row.status}` };
    }
    this.db
      .query(
        "INSERT OR IGNORE INTO note_edges (id, project_id, source_id, target_id, predicate, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(randomUUID(), projectID, sourceID, targetID, predicate as Predicate, Date.now());
    return { ok: true, projectID, projectName: project.name };
  }

  recall(projectID: string, query: string, limit = 10): RecallCard[] {
    const tokens = query
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .slice(0, 12)
      .map((token) => `"${token.replace(/"/g, '""')}"`);
    if (tokens.length === 0) return [];
    const matches = this.db
      .query(
        `SELECT n.*, p.name AS project_name, bm25(notes_fts) AS rank
           FROM notes_fts
           JOIN notes n ON n.id = notes_fts.id
           JOIN projects p ON p.id = n.project_id
          WHERE notes_fts MATCH ? AND n.project_id = ? AND n.status = 'active'
          ORDER BY n.pinned DESC, rank
          LIMIT ?`,
      )
      .all(tokens.join(" OR "), projectID, limit) as Array<NoteRow & { rank: number }>;

    const cards = matches.map((row) => toCard(rowToNote(row), "match"));
    const seen = new Set(cards.map((card) => card.id));
    for (const match of matches.slice(0, 5)) {
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
            ORDER BY n.pinned DESC
            LIMIT 6`,
        )
        .all(match.id, projectID, match.id, match.id, projectID) as Array<
        NoteRow & { predicate: string }
      >;
      for (const neighbor of neighbors) {
        if (seen.has(neighbor.id)) continue;
        seen.add(neighbor.id);
        const card = toCard(rowToNote(neighbor), "neighbor");
        card.predicates = [neighbor.predicate];
        cards.push(card);
      }
    }
    return cards.slice(0, limit + 5);
  }

  private getProjectRow(id: string): ProjectRow | undefined {
    return this.db.query("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  }

  private projectNameExists(normalizedName: string, excludingID?: string): boolean {
    const row = excludingID
      ? this.db
          .query("SELECT id FROM projects WHERE normalized_name = ? AND id != ?")
          .get(normalizedName, excludingID)
      : this.db.query("SELECT id FROM projects WHERE normalized_name = ?").get(normalizedName);
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
}

interface ProjectRow {
  id: string;
  name: string;
  normalized_name: string;
  created_at: number;
  updated_at: number;
}

interface NoteRow {
  id: string;
  project_id: string;
  project_name: string;
  kind: Kind;
  title: string;
  summary: string;
  content: string;
  size_class: "inline" | "indexed";
  pinned: number;
  status: "active" | "superseded" | "archived";
  supersedes_id: string | null;
  created_at: number;
  updated_at: number;
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
