import { createHash, randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { noteContentHash } from "../db/migrations/v009";
import {
  parseCaptureEvent,
  type CaptureEventV1,
  type MemoryCandidateV1,
} from "../capture/contract";
import { canAutoWrite, EXTRACTOR_VERSION, normalizeSubjectKey } from "../capture/policy";
import { REDACTION_POLICY_VERSION, redactText } from "../capture/redact";
import { deriveDocument } from "../retrieval/derived";

export interface ProjectBindingInput {
  memoryProjectID: string;
  opencodeProjectID: string;
  canonicalDirectory: string;
  workspaceID?: string;
}

export type CaptureMode = "shadow" | "auto-write";

export interface CaptureIngestResult {
  outcome:
    | "shadowed"
    | "materialized"
    | "duplicate"
    | "ignored"
    | "review"
    | "rejected"
    | "quarantined";
  idempotencyKey: string;
  noteID?: string;
  existing?: boolean;
}

export class CaptureStore {
  constructor(
    private db: Database,
    private indexBackends: readonly string[] = [],
  ) {}

  bindProject(input: ProjectBindingInput): { bindingKey: string; projectID: string } {
    const workspaceID = input.workspaceID ?? "";
    const canonicalPathHash = sha256(input.canonicalDirectory);
    const bindingKey = sha256(
      ["opencode-v2", input.opencodeProjectID, workspaceID, canonicalPathHash].join("\0"),
    );
    const project = this.db.query("SELECT id FROM projects WHERE id = ?").get(input.memoryProjectID);
    if (!project) throw new Error(`memory project ${input.memoryProjectID} not found`);
    const existing = this.db
      .query(
        `SELECT * FROM project_bindings
          WHERE source = 'opencode-v2' AND source_project_id = ? AND workspace_id = ?`,
      )
      .get(input.opencodeProjectID, workspaceID) as BindingRow | undefined;
    if (existing) {
      if (
        existing.binding_key !== bindingKey ||
        existing.project_id !== input.memoryProjectID ||
        existing.canonical_path_hash !== canonicalPathHash
      ) {
        throw new Error("binding_conflict");
      }
      return { bindingKey, projectID: existing.project_id };
    }
    const now = Date.now();
    this.db.query(`
      INSERT INTO project_bindings
        (binding_key, project_id, source, source_project_id, workspace_id,
         canonical_path_hash, created_at, updated_at)
      VALUES (?, ?, 'opencode-v2', ?, ?, ?, ?, ?)
    `).run(
      bindingKey,
      input.memoryProjectID,
      input.opencodeProjectID,
      workspaceID,
      canonicalPathHash,
      now,
      now,
    );
    return { bindingKey, projectID: input.memoryProjectID };
  }

  checkpoint(
    sessionID: string,
    bindingKey: string,
    projectID: string,
    messageID?: string,
    state: "active" | "idle" | "unavailable" | "closed" = "active",
  ): void {
    const binding = this.binding(bindingKey, projectID);
    if (!binding) throw new Error("binding_conflict");
    const now = Date.now();
    this.db.query(`
      INSERT INTO capture_checkpoints
        (session_id, binding_key, project_id, state, last_message_id,
         next_reconcile_at, failure_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        binding_key = excluded.binding_key,
        project_id = excluded.project_id,
        state = excluded.state,
        last_message_id = COALESCE(excluded.last_message_id, capture_checkpoints.last_message_id),
        next_reconcile_at = excluded.next_reconcile_at,
        updated_at = excluded.updated_at
      WHERE capture_checkpoints.binding_key = excluded.binding_key
        AND capture_checkpoints.project_id = excluded.project_id
    `).run(sessionID, bindingKey, projectID, state, messageID ?? null, now, now, now);
    const row = this.db
      .query("SELECT binding_key, project_id FROM capture_checkpoints WHERE session_id = ?")
      .get(sessionID) as { binding_key: string; project_id: string } | undefined;
    if (!row || row.binding_key !== bindingKey || row.project_id !== projectID) {
      throw new Error("checkpoint_binding_conflict");
    }
  }

  markReconciled(
    sessionID: string,
    state: "active" | "idle" | "unavailable" | "closed",
    lastMessageID?: string,
    failed = false,
  ): void {
    const now = Date.now();
    const result = this.db.query(`
      UPDATE capture_checkpoints
         SET state = ?,
             last_message_id = COALESCE(?, last_message_id),
             last_reconciled_at = ?,
             next_reconcile_at = ?,
             failure_count = CASE WHEN ? THEN failure_count + 1 ELSE 0 END,
             updated_at = ?
       WHERE session_id = ?
    `).run(state, lastMessageID ?? null, now, now + (failed ? 5_000 : 30_000), failed, now, sessionID);
    if (result.changes === 0) throw new Error(`checkpoint ${sessionID} not found`);
  }

  getCheckpoint(sessionID: string): {
    sessionID: string;
    lastMessageID?: string;
    state: "active" | "idle" | "unavailable" | "closed";
  } | undefined {
    const row = this.db
      .query(
        "SELECT session_id, last_message_id, state FROM capture_checkpoints WHERE session_id = ?",
      )
      .get(sessionID) as
      | {
          session_id: string;
          last_message_id: string | null;
          state: "active" | "idle" | "unavailable" | "closed";
        }
      | undefined;
    return row
      ? {
          sessionID: row.session_id,
          ...(row.last_message_id ? { lastMessageID: row.last_message_id } : {}),
          state: row.state,
        }
      : undefined;
  }

  ingest(
    input: unknown,
    mode: CaptureMode,
    options: { allowedKinds?: readonly string[]; minConfidence?: number; denylist?: readonly string[] } = {},
  ): CaptureIngestResult {
    const parsed = parseCaptureEvent(input);
    if (!this.binding(parsed.bindingKey, parsed.projectID)) throw new Error("binding_conflict");
    const prepared = prepareForPersistence(parsed, options.denylist);
    const now = Date.now();
    let result: CaptureIngestResult = {
      outcome: prepared.quarantined ? "quarantined" : "shadowed",
      idempotencyKey: parsed.idempotencyKey,
    };

    this.db.transaction(() => {
      const inserted = this.db.query(`
        INSERT OR IGNORE INTO capture_events
          (idempotency_key, contract, project_id, binding_key, event_kind,
           source_session_id, source_message_id, source_ordinal, source_tool_call_id,
           payload_json, payload_hash, redaction_version, state, attempt_count,
           generation, created_at, updated_at, processed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
      `).run(
        prepared.event.idempotencyKey,
        prepared.event.schema,
        prepared.event.projectID,
        prepared.event.bindingKey,
        prepared.event.kind,
        prepared.event.source.sessionID,
        prepared.event.source.messageID ?? null,
        prepared.event.source.ordinal ?? null,
        prepared.event.source.toolCallID ?? null,
        prepared.payload,
        prepared.payloadHash,
        REDACTION_POLICY_VERSION,
        prepared.quarantined ? "quarantined" : "pending",
        now,
        now,
        prepared.quarantined ? now : null,
      );
      if (inserted.changes === 0) {
        const existing = this.db
          .query("SELECT state, note_id FROM capture_events WHERE idempotency_key = ?")
          .get(parsed.idempotencyKey) as { state: CaptureIngestResult["outcome"]; note_id: string | null };
        result = {
          outcome: "duplicate",
          idempotencyKey: parsed.idempotencyKey,
          ...(existing.note_id ? { noteID: existing.note_id } : {}),
          existing: true,
        };
        return;
      }
      if (prepared.quarantined) return;
      if (mode === "shadow") {
        this.finishEvent(parsed.idempotencyKey, "shadowed", null, now);
        result.outcome = "shadowed";
        return;
      }
      const candidate = prepared.event.candidate;
      if (!candidate) {
        this.finishEvent(parsed.idempotencyKey, "shadowed", null, now);
        result.outcome = "shadowed";
        return;
      }
      if (candidate.intent === "ignore") {
        this.finishEvent(parsed.idempotencyKey, "ignored", null, now);
        result.outcome = "ignored";
        return;
      }
      if (
        candidate.intent === "review" ||
        !canAutoWrite(
          candidate,
          {
            truncated: prepared.event.redaction.truncated,
            quarantined: prepared.event.redaction.replacements > 0,
          },
          options.allowedKinds,
          options.minConfidence,
        )
      ) {
        this.finishEvent(parsed.idempotencyKey, "review", null, now);
        result.outcome = "review";
        return;
      }
      result = this.materialize(prepared.event, candidate, now);
    })();
    return result;
  }

  runRetention(now = Date.now(), batchSize = 100): { summarized: number; deleted: number; checkpoints: number } {
    const terminalCutoff = now - 30 * 24 * 60 * 60 * 1_000;
    const quarantineCutoff = now - 7 * 24 * 60 * 60 * 1_000;
    const summarized = this.db.query(`
      UPDATE capture_events
         SET payload_json = NULL, payload_hash = NULL, updated_at = ?
       WHERE idempotency_key IN (
         SELECT idempotency_key FROM capture_events
          WHERE state IN ('materialized','duplicate','ignored','rejected','shadowed')
            AND processed_at < ? AND payload_json IS NOT NULL
          ORDER BY processed_at LIMIT ?
       )
    `).run(now, terminalCutoff, batchSize).changes;
    const deleted = this.db.query(`
      DELETE FROM capture_events
       WHERE idempotency_key IN (
         SELECT idempotency_key FROM capture_events
          WHERE state = 'quarantined' AND processed_at < ?
          ORDER BY processed_at LIMIT ?
       )
    `).run(quarantineCutoff, batchSize).changes;
    const checkpoints = this.db.query(`
      DELETE FROM capture_checkpoints
       WHERE session_id IN (
         SELECT session_id FROM capture_checkpoints
          WHERE (state = 'idle' AND updated_at < ?)
             OR (state = 'unavailable' AND updated_at < ?)
          ORDER BY updated_at LIMIT ?
       )
    `).run(terminalCutoff, quarantineCutoff, batchSize).changes;
    return { summarized, deleted, checkpoints };
  }

  private materialize(
    event: CaptureEventV1,
    candidate: MemoryCandidateV1,
    now: number,
  ): CaptureIngestResult {
    const subjectKey = candidate.subjectKey ? normalizeSubjectKey(candidate.subjectKey) : null;
    const hash = noteContentHash(candidate.kind, candidate.title, candidate.summary, candidate.content);
    const existing = subjectKey
      ? (this.db
          .query(
            `SELECT * FROM notes
              WHERE project_id = ? AND kind = ? AND subject_key = ? AND status = 'active'`,
          )
          .get(event.projectID, candidate.kind, subjectKey) as NoteRow | undefined)
      : undefined;
    if (existing?.content_hash === hash) {
      this.finishEvent(event.idempotencyKey, "duplicate", existing.id, now);
      return { outcome: "duplicate", idempotencyKey: event.idempotencyKey, noteID: existing.id };
    }
    if (existing) {
      if (
        candidate.intent !== "supersede" ||
        candidate.targetNoteID !== existing.id ||
        candidate.confidence < 0.95
      ) {
        this.finishEvent(event.idempotencyKey, "review", existing.id, now);
        return { outcome: "review", idempotencyKey: event.idempotencyKey, noteID: existing.id };
      }
      this.db.query(`
        UPDATE notes
           SET status = 'superseded', current_revision = current_revision + 1, updated_at = ?
         WHERE project_id = ? AND id = ? AND status = 'active'
      `).run(now, event.projectID, existing.id);
      this.recordRevision(event, existing.id, now);
      const id = this.insertCapturedNote(event, candidate, subjectKey, existing.id, hash, now);
      this.db.query(`
        INSERT INTO note_edges
          (id, project_id, source_id, target_id, predicate, created_at)
        VALUES (?, ?, ?, ?, 'SUPERSEDES', ?)
      `).run(randomUUID(), event.projectID, id, existing.id, now);
      for (const backend of this.indexBackends) {
        this.enqueueOutbox(
          backend,
          "delete-note",
          event.projectID,
          existing.id,
          existing.current_revision + 1,
          existing.content_hash,
          now,
        );
        const note = this.db.query("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow;
        this.enqueueOutbox(
          backend,
          "upsert-note",
          event.projectID,
          id,
          1,
          derivedHash(note),
          now,
        );
      }
      this.finishEvent(event.idempotencyKey, "materialized", id, now);
      return { outcome: "materialized", idempotencyKey: event.idempotencyKey, noteID: id };
    }
    if (candidate.intent === "supersede") {
      this.finishEvent(event.idempotencyKey, "review", candidate.targetNoteID ?? null, now);
      return {
        outcome: "review",
        idempotencyKey: event.idempotencyKey,
        ...(candidate.targetNoteID ? { noteID: candidate.targetNoteID } : {}),
      };
    }
    const id = this.insertCapturedNote(event, candidate, subjectKey, null, hash, now);
    const note = this.db.query("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow;
    for (const backend of this.indexBackends) {
      this.enqueueOutbox(backend, "upsert-note", event.projectID, id, 1, derivedHash(note), now);
    }
    this.finishEvent(event.idempotencyKey, "materialized", id, now);
    return { outcome: "materialized", idempotencyKey: event.idempotencyKey, noteID: id };
  }

  private insertCapturedNote(
    event: CaptureEventV1,
    candidate: MemoryCandidateV1,
    subjectKey: string | null,
    supersedesID: string | null,
    contentHash: string,
    now: number,
  ): string {
    const id = randomUUID();
    const sizeClass = candidate.content.length <= 1_200 ? "inline" : "indexed";
    this.db.query(`
      INSERT INTO notes
        (id, project_id, kind, title, summary, content, size_class, pinned, status,
         supersedes_id, current_revision, subject_key, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, 1, ?, ?, ?, ?)
    `).run(
      id,
      event.projectID,
      candidate.kind,
      candidate.title,
      candidate.summary,
      candidate.content,
      sizeClass,
      supersedesID,
      subjectKey,
      contentHash,
      now,
      now,
    );
    this.recordRevision(event, id, now);
    return id;
  }

  private recordRevision(event: CaptureEventV1, noteID: string, now: number): void {
    const note = this.db
      .query("SELECT * FROM notes WHERE project_id = ? AND id = ?")
      .get(event.projectID, noteID) as NoteRow;
    const provenanceID = randomUUID();
    this.db.query(`
      INSERT INTO note_provenance
        (id, project_id, note_id, source_type, capture_event_id, source_session_id,
         source_message_id, source_ordinal, source_tool_call_id, redaction_version,
         extractor_version, confidence, created_at)
      VALUES (?, ?, ?, 'opencode-capture', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      provenanceID,
      event.projectID,
      noteID,
      event.idempotencyKey,
      event.source.sessionID,
      event.source.messageID ?? null,
      event.source.ordinal ?? null,
      event.source.toolCallID ?? null,
      REDACTION_POLICY_VERSION,
      EXTRACTOR_VERSION,
      event.candidate?.confidence ?? null,
      now,
    );
    this.db.query(`
      INSERT INTO note_revisions
        (project_id, note_id, revision, kind, title, summary, content, size_class,
         pinned, status, supersedes_id, subject_key, content_hash, provenance_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
  }

  private enqueueOutbox(
    backend: string,
    operation: "upsert-note" | "delete-note",
    projectID: string,
    noteID: string,
    revision: number,
    contentHash: string | null,
    now: number,
  ): void {
    this.db.query(`
      INSERT OR IGNORE INTO index_outbox
        (backend, operation, project_id, note_id, revision, content_hash,
         state, attempt_count, available_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(backend, operation, projectID, noteID, revision, contentHash, now, now);
  }

  private finishEvent(
    idempotencyKey: string,
    state: CaptureIngestResult["outcome"],
    noteID: string | null,
    now: number,
  ): void {
    this.db.query(`
      UPDATE capture_events
         SET state = ?, note_id = ?, updated_at = ?, processed_at = ?
       WHERE idempotency_key = ?
    `).run(state, noteID, now, now, idempotencyKey);
  }

  private binding(bindingKey: string, projectID: string): BindingRow | undefined {
    return this.db
      .query("SELECT * FROM project_bindings WHERE binding_key = ? AND project_id = ?")
      .get(bindingKey, projectID) as BindingRow | undefined;
  }
}

function prepareForPersistence(event: CaptureEventV1, denylist?: readonly string[]) {
  const copy = structuredClone(event);
  let replacements = 0;
  let truncated = copy.redaction.truncated;
  let quarantined = event.redaction.policyVersion.endsWith("/quarantined");
  if (copy.candidate) {
    for (const field of ["title", "summary", "content", "subjectKey"] as const) {
      const value = copy.candidate[field];
      if (typeof value !== "string") continue;
      const maximum = field === "title" || field === "subjectKey" ? 240 : field === "summary" ? 1_200 : 4_800;
      const result = redactText(value, { maxCharacters: maximum, denylist });
      copy.candidate[field] = result.text;
      replacements += result.replacements;
      truncated ||= result.truncated;
      quarantined ||= result.quarantined;
    }
  }
  if (copy.signal) {
    for (const field of ["tool", "errorType"] as const) {
      const value = copy.signal[field];
      if (typeof value !== "string") continue;
      const result = redactText(value, { maxCharacters: 160, denylist });
      copy.signal[field] = result.text;
      replacements += result.replacements;
      truncated ||= result.truncated;
      quarantined ||= result.quarantined;
    }
  }
  copy.redaction = {
    policyVersion: REDACTION_POLICY_VERSION,
    replacements: copy.redaction.replacements + replacements,
    truncated,
  };
  const validated = parseCaptureEvent(copy);
  const payload = quarantined ? null : JSON.stringify(validated);
  return {
    event: validated,
    payload,
    payloadHash: payload ? sha256(payload) : null,
    quarantined,
    additionalReplacements: replacements,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function derivedHash(note: NoteRow): string | null {
  return (
    deriveDocument({
      projectID: note.project_id,
      noteID: note.id,
      revision: note.current_revision,
      kind: note.kind,
      title: note.title,
      summary: note.summary,
      content: note.content,
    })?.contentHash ?? null
  );
}

interface BindingRow {
  binding_key: string;
  project_id: string;
  canonical_path_hash: string;
}

interface NoteRow {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  summary: string;
  content: string;
  size_class: string;
  pinned: number;
  status: string;
  supersedes_id: string | null;
  current_revision: number;
  subject_key: string | null;
  content_hash: string;
}
