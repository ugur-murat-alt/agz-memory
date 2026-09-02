import type { Database } from "bun:sqlite";
import { redactText } from "../capture/redact";
import { deriveDocument } from "../retrieval/derived";
import {
  validateBackendHits,
  type RetrievalBackend,
  type RetrievalRequest,
  type RankedHit,
} from "../retrieval/contract";
import { weightedReciprocalRankFusion } from "../retrieval/fusion";
import type { RecallCard } from "../types";

const MAX_CARDS = 8;
const MAX_CHANNEL_RESULTS = 40;
const MAX_SEMANTIC_QUERY_BYTES = 1_200;
const MAX_SQL_IDS = 900;
const MAX_SEMANTIC_TIMEOUT_MS = 120;

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
    const limit = boundedCardLimit(request.limit);
    if (!query || limit === 0 || Date.now() >= request.deadlineAt) {
      return { cards: [], semanticFallback: false, rejectedBackendHits: 0 };
    }
    const lexical = this.lexical(request.projectID, query, MAX_CHANNEL_RESULTS);
    if (Date.now() >= request.deadlineAt) {
      return { cards: [], semanticFallback: false, rejectedBackendHits: 0 };
    }

    let semantic: RankedHit[] = [];
    let semanticFallback = false;
    const queryRedaction = redactText(query);
    if (
      request.semantic !== "off" &&
      this.backend &&
      queryRedaction.replacements === 0 &&
      Date.now() < request.deadlineAt
    ) {
      const semanticQuery = truncateUtf8(query, MAX_SEMANTIC_QUERY_BYTES);
      const remaining = request.deadlineAt - Date.now();
      const timeoutMs = Math.max(1, Math.min(MAX_SEMANTIC_TIMEOUT_MS, remaining));
      try {
        const result = await withHardTimeout(
          (signal) => this.backend!.query(request.projectID, semanticQuery, MAX_CHANNEL_RESULTS, signal),
          timeoutMs,
          request.deadlineAt,
        );
        if (!validateBackendHits(result)) {
          semanticFallback = true;
        } else {
          semantic = result;
        }
      } catch {
        semanticFallback = true;
      }
    }

    if (Date.now() >= request.deadlineAt) {
      return { cards: [], semanticFallback, rejectedBackendHits: 0 };
    }

    let rejectedBackendHits = 0;
    let validSemantic: RankedHit[] = [];
    if (semantic.length > 0) {
      const semanticRows = this.notes(request.projectID, uniqueIDs(semantic.map((hit) => hit.noteID)));
      validSemantic = semantic.filter((hit) => {
        const row = semanticRows.get(hit.noteID);
        const derived = row && row.status === "active" ? deriveDocument(toDocumentSource(row)) : undefined;
        const valid = Boolean(
          hit.channel === "semantic" &&
            row &&
            row.status === "active" &&
            hit.revision === row.current_revision &&
            derived &&
            hit.contentHash === derived.contentHash,
        );
        if (!valid) rejectedBackendHits++;
        return valid;
      });
      validSemantic.sort(compareRankedHits);
      validSemantic = validSemantic.slice(0, MAX_CHANNEL_RESULTS);
    }

    if (Date.now() >= request.deadlineAt) {
      return { cards: [], semanticFallback, rejectedBackendHits };
    }

    const direct = [...lexical, ...validSemantic].sort(compareRankedHits);
    const graph = this.graph(
      request.projectID,
      uniqueIDs(direct.map((hit) => hit.noteID)).slice(0, 10),
      30,
    );
    if (Date.now() >= request.deadlineAt) {
      return { cards: [], semanticFallback, rejectedBackendHits };
    }

    const fused = weightedReciprocalRankFusion([...direct, ...graph].sort(compareRankedHits));
    const rowsByID = this.notes(request.projectID, uniqueIDs(fused.map((hit) => hit.noteID)));
    const rows = fused
      .map((hit) => {
        const row = rowsByID.get(hit.noteID);
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
    if (Date.now() >= request.deadlineAt) {
      return { cards: [], semanticFallback, rejectedBackendHits };
    }

    const selectedRows = rows.slice(0, limit);
    const graphPredicates = this.graphPredicates(
      request.projectID,
      selectedRows.map(({ row }) => row.id),
    );
    if (Date.now() >= request.deadlineAt) {
      return { cards: [], semanticFallback, rejectedBackendHits };
    }
    const cards = selectedRows.map(({ hit, row }) => ({
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
        ? { predicates: [...graphPredicates.get(row.id)!].sort() }
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
    const endpoint = `CASE WHEN e.source_id IN (${values}) THEN e.target_id ELSE e.source_id END`;
    const rows = this.db
      .query(`
        SELECT DISTINCT ${endpoint} AS id
          FROM note_edges e
          JOIN notes n
            ON n.id = ${endpoint}
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

  private notes(projectID: string, noteIDs: readonly string[]): Map<string, NoteRow> {
    const result = new Map<string, NoteRow>();
    const unique = uniqueIDs(noteIDs);
    for (let offset = 0; offset < unique.length; offset += MAX_SQL_IDS) {
      const chunk = unique.slice(offset, offset + MAX_SQL_IDS);
      if (chunk.length === 0) continue;
      const values = chunk.map(() => "?").join(",");
      const rows = this.db
        .query(`
          SELECT n.*, p.name AS project_name
            FROM notes n JOIN projects p ON p.id = n.project_id
           WHERE n.project_id = ? AND n.id IN (${values})
        `)
        .all(projectID, ...chunk) as NoteRow[];
      for (const row of rows) result.set(row.id, row);
    }
    return result;
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

function boundedCardLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 0;
  return Math.min(MAX_CARDS, Math.max(0, Math.floor(limit)));
}

function uniqueIDs(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function compareRankedHits(left: RankedHit, right: RankedHit): number {
  return (
    left.channel.localeCompare(right.channel) ||
    left.rank - right.rank ||
    left.noteID.localeCompare(right.noteID) ||
    (left.score ?? 0) - (right.score ?? 0) ||
    (left.revision ?? 0) - (right.revision ?? 0) ||
    (left.contentHash ?? "").localeCompare(right.contentHash ?? "")
  );
}

function toDocumentSource(row: NoteRow) {
  return {
    projectID: row.project_id,
    noteID: row.id,
    revision: row.current_revision,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    content: row.content,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const encoded = Buffer.from(character, "utf8");
    if (bytes + encoded.length > maxBytes) break;
    result += character;
    bytes += encoded.length;
  }
  return result;
}

async function withHardTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  deadlineAt: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const pending = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await new Promise<T>((resolve, reject) => {
      const finish = (callback: () => void) => {
        if (timer) clearTimeout(timer);
        callback();
      };
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        finish(() => reject(new Error("semantic_timeout")));
      }, Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now())));
      pending.then(
        (value) => {
          if (timedOut) return;
          finish(() => resolve(value));
        },
        (error) => {
          if (timedOut) return;
          finish(() => reject(error));
        },
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
