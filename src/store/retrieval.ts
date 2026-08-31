import type { Database } from "bun:sqlite";
import { redactText } from "../capture/redact";
import type { RetrievalBackend, RetrievalRequest, RankedHit } from "../retrieval/contract";
import { weightedReciprocalRankFusion } from "../retrieval/fusion";
import type { RecallCard } from "../types";

export interface RetrievalResult {
  cards: RecallCard[];
  semanticFallback: boolean;
  rejectedBackendHits: number;
}

export class RetrievalStore {
  constructor(
    private db: Database,
    private backend?: RetrievalBackend,
  ) {}

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const query = request.query.trim();
    if (!query || request.limit <= 0 || Date.now() >= request.deadlineAt) {
      return { cards: [], semanticFallback: false, rejectedBackendHits: 0 };
    }
    const lexical = this.lexical(request.projectID, query, 40);
    let semantic: RankedHit[] = [];
    let semanticFallback = false;
    const queryRedaction = redactText(query);
    if (
      request.semantic !== "off" &&
      this.backend &&
      queryRedaction.replacements === 0 &&
      Date.now() < request.deadlineAt
    ) {
      const controller = new AbortController();
      const timeoutMs = Math.max(1, Math.min(120, request.deadlineAt - Date.now()));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        semantic = await Promise.race([
          this.backend.query(request.projectID, query.slice(0, 1_200), 40, controller.signal),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new Error("semantic_timeout"));
            }, timeoutMs);
          }),
        ]);
      } catch {
        semanticFallback = true;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    let rejectedBackendHits = 0;
    const validSemantic = semantic.filter((hit) => {
      const row = this.note(request.projectID, hit.noteID);
      const valid = Boolean(
        row &&
          row.status === "active" &&
          (hit.revision === undefined || hit.revision === row.current_revision) &&
          (hit.contentHash === undefined || hit.contentHash === row.content_hash),
      );
      if (!valid) rejectedBackendHits++;
      return valid;
    });
    const direct = [...lexical, ...validSemantic];
    const graph = this.graph(request.projectID, direct.slice(0, 10).map((hit) => hit.noteID), 30);
    const fused = weightedReciprocalRankFusion([...direct, ...graph]);
    const rows = fused
      .map((hit) => {
        const row = this.note(request.projectID, hit.noteID);
        if (!row || row.status !== "active") return undefined;
        return { hit, row };
      })
      .filter((value): value is { hit: (typeof fused)[number]; row: NoteRow } => Boolean(value));
    rows.sort(
      (left, right) =>
        Number(right.hit.matchedCandidate) - Number(left.hit.matchedCandidate) ||
        right.row.pinned - left.row.pinned ||
        right.hit.score - left.hit.score ||
        right.row.updated_at - left.row.updated_at ||
        left.row.id.localeCompare(right.row.id),
    );
    const graphPredicates = this.graphPredicates(request.projectID, rows.map(({ row }) => row.id));
    const cards = rows.slice(0, request.limit).map(({ hit, row }) => ({
      id: row.id,
      projectID: row.project_id,
      projectName: row.project_name,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      content: row.size_class === "inline" ? row.content : undefined,
      sizeClass: row.size_class,
      pinned: row.pinned === 1,
      via: hit.matchedCandidate ? ("match" as const) : ("neighbor" as const),
      ...(!hit.matchedCandidate && graphPredicates.has(row.id)
        ? { predicates: [...graphPredicates.get(row.id)!] }
        : {}),
    }));
    return { cards, semanticFallback, rejectedBackendHits };
  }

  private lexical(projectID: string, query: string, limit: number): RankedHit[] {
    const tokens = query
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .slice(0, 12)
      .map((token) => `"${token.replace(/"/g, '""')}"`);
    if (tokens.length === 0) return [];
    const rows = this.db
      .query(`
        SELECT n.id, bm25(notes_fts) AS score
          FROM notes_fts
          JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ? AND n.project_id = ? AND n.status = 'active'
         ORDER BY score, n.updated_at DESC, n.id
         LIMIT ?
      `)
      .all(tokens.join(" OR "), projectID, limit) as Array<{ id: string; score: number }>;
    return rows.map((row, index) => ({
      noteID: row.id,
      channel: "lexical",
      rank: index + 1,
      score: row.score,
    }));
  }

  private graph(projectID: string, noteIDs: readonly string[], limit: number): RankedHit[] {
    if (noteIDs.length === 0) return [];
    const values = noteIDs.map(() => "?").join(",");
    const rows = this.db
      .query(`
        SELECT DISTINCT CASE WHEN e.source_id IN (${values}) THEN e.target_id ELSE e.source_id END AS id
          FROM note_edges e
          JOIN notes n
            ON n.id = CASE WHEN e.source_id IN (${values}) THEN e.target_id ELSE e.source_id END
         WHERE e.project_id = ?
           AND (e.source_id IN (${values}) OR e.target_id IN (${values}))
           AND n.project_id = ? AND n.status = 'active'
         ORDER BY n.pinned DESC, n.updated_at DESC, n.id
         LIMIT ?
      `)
      .all(
        ...noteIDs,
        ...noteIDs,
        projectID,
        ...noteIDs,
        ...noteIDs,
        projectID,
        limit,
      ) as Array<{ id: string }>;
    const direct = new Set(noteIDs);
    return rows
      .filter((row) => !direct.has(row.id))
      .map((row, index) => ({ noteID: row.id, channel: "graph", rank: index + 1 }));
  }

  private graphPredicates(projectID: string, noteIDs: readonly string[]): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    if (noteIDs.length === 0) return result;
    const values = noteIDs.map(() => "?").join(",");
    const rows = this.db
      .query(
        `SELECT source_id, target_id, predicate FROM note_edges
          WHERE project_id = ? AND (source_id IN (${values}) OR target_id IN (${values}))`,
      )
      .all(projectID, ...noteIDs, ...noteIDs) as Array<{
      source_id: string;
      target_id: string;
      predicate: string;
    }>;
    for (const row of rows) {
      for (const id of [row.source_id, row.target_id]) {
        if (!noteIDs.includes(id)) continue;
        const predicates = result.get(id) ?? new Set<string>();
        predicates.add(row.predicate);
        result.set(id, predicates);
      }
    }
    return result;
  }

  private note(projectID: string, noteID: string): NoteRow | undefined {
    return this.db
      .query(`
        SELECT n.*, p.name AS project_name
          FROM notes n JOIN projects p ON p.id = n.project_id
         WHERE n.project_id = ? AND n.id = ?
      `)
      .get(projectID, noteID) as NoteRow | undefined;
  }
}

interface NoteRow {
  id: string;
  project_id: string;
  project_name: string;
  kind: RecallCard["kind"];
  title: string;
  summary: string;
  content: string;
  size_class: RecallCard["sizeClass"];
  pinned: number;
  status: "active" | "superseded" | "archived";
  current_revision: number;
  content_hash: string;
  updated_at: number;
}
