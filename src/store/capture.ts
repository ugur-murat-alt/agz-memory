import { createHash, randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { captureIdempotencyKey } from "../capture/identity";
import {
  parseCaptureEvent,
  type CaptureEventV1,
  type MemoryCandidateV1,
} from "../capture/contract";
import {
  canAutoWrite,
  EXTRACTOR_VERSION,
  normalizeSubjectKey,
} from "../capture/policy";
import { REDACTION_POLICY_VERSION, redactText } from "../capture/redact";
import { hashTuple, noteContentHash } from "../hash";
import { deriveDocument } from "../retrieval/derived";

export interface ProjectBindingInput {
  memoryProjectID: string;
  opencodeProjectID: string;
  canonicalDirectory: string;
  workspaceID?: string;
}

export type CaptureMode = "shadow" | "auto-write";

type CheckpointState = "active" | "idle" | "unavailable" | "closed";

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

  bindProject(input: ProjectBindingInput): {
    ok: true;
    bindingKey: string;
    projectID: string;
  } {
    const workspaceID = input.workspaceID ?? "";
    const canonicalPathHash = hashTuple("canonical-path", 2, [
      input.canonicalDirectory,
    ]);
    const bindingKey = hashTuple("project-binding", 2, [
      "opencode-v2",
      input.opencodeProjectID,
      workspaceID,
      canonicalPathHash,
    ]);
    const project = this.db
      .query("SELECT id FROM projects WHERE id = ?")
      .get(input.memoryProjectID);
    if (!project)
      throw new Error(`memory project ${input.memoryProjectID} not found`);
    const existing = this.db
      .query(
        `SELECT * FROM project_bindings
          WHERE source = 'opencode-v2' AND source_project_id = ? AND workspace_id = ?`,
      )
      .get(input.opencodeProjectID, workspaceID) as BindingRow | undefined;
    if (existing) {
      return bindingResult(existing, input, bindingKey, canonicalPathHash);
    }
    const now = Date.now();
    try {
      this.db
        .query(
          `
        INSERT INTO project_bindings
          (binding_key, project_id, source, source_project_id, workspace_id,
           canonical_path_hash, created_at, updated_at)
        VALUES (?, ?, 'opencode-v2', ?, ?, ?, ?, ?)
        ON CONFLICT(source, source_project_id, workspace_id) DO NOTHING
      `,
        )
        .run(
          bindingKey,
          input.memoryProjectID,
          input.opencodeProjectID,
          workspaceID,
          canonicalPathHash,
          now,
          now,
        );
    } catch (error) {
      const collision = this.db
        .query("SELECT binding_key FROM project_bindings WHERE binding_key = ?")
        .get(bindingKey);
      if (collision) throw new Error("binding_conflict");
      throw error;
    }
    const committed = this.db
      .query(
        `SELECT * FROM project_bindings
          WHERE source = 'opencode-v2' AND source_project_id = ? AND workspace_id = ?`,
      )
      .get(input.opencodeProjectID, workspaceID) as BindingRow | undefined;
    if (!committed) throw new Error("binding_conflict");
    return bindingResult(committed, input, bindingKey, canonicalPathHash);
  }

  checkpoint(
    sessionID: string,
    bindingKey: string,
    projectID: string,
    messageID?: string,
    state: CheckpointState = "active",
  ): void {
    const binding = this.binding(bindingKey, projectID);
    if (!binding) throw new Error("binding_conflict");
    const now = Date.now();
    this.db
      .query(
        `
      INSERT INTO capture_checkpoints
        (session_id, binding_key, project_id, state, last_message_id,
         next_reconcile_at, failure_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(binding_key, session_id) DO UPDATE SET
        state = excluded.state,
        last_message_id = COALESCE(excluded.last_message_id, capture_checkpoints.last_message_id),
        next_reconcile_at = excluded.next_reconcile_at,
        updated_at = excluded.updated_at
      WHERE capture_checkpoints.binding_key = excluded.binding_key
         AND capture_checkpoints.project_id = excluded.project_id
    `,
      )
      .run(
        sessionID,
        bindingKey,
        projectID,
        state,
        messageID ?? null,
        now,
        now,
        now,
      );
    const row = this.checkpointRow(bindingKey, sessionID, projectID);
    if (
      !row ||
      row.binding_key !== bindingKey ||
      row.project_id !== projectID
    ) {
      throw new Error("checkpoint_binding_conflict");
    }
  }

  markReconciled(
    sessionID: string,
    state: CheckpointState,
    lastMessageID?: string,
    failed?: boolean,
    bindingKey?: string,
    projectID?: string,
  ): void;
  markReconciled(
    sessionID: string,
    bindingKey: string,
    state: CheckpointState,
    lastMessageID?: string,
    failed?: boolean,
    projectID?: string,
  ): void;
  markReconciled(
    sessionID: string,
    bindingKey: string,
    projectID: string,
    state: CheckpointState,
    lastMessageID?: string,
    failed?: boolean,
  ): void;
  markReconciled(
    firstID: string,
    second: CheckpointState | string,
    third?: CheckpointState | string,
    fourth?: string | boolean,
    fifth?: boolean | string,
    sixth?: string | boolean,
  ): void {
    let sessionID: string;
    let bindingKey: string | undefined;
    let projectID: string | undefined;
    let state: CheckpointState;
    let lastMessageID: string | undefined;
    let failed = false;

    if (isCheckpointState(second)) {
      sessionID = firstID;
      state = second;
      if (third !== undefined && typeof third !== "string")
        throw new Error("checkpoint_value_invalid");
      lastMessageID = third;
      if (fourth !== undefined && typeof fourth !== "boolean")
        throw new Error("checkpoint_value_invalid");
      failed = fourth ?? false;
      if (fifth !== undefined && typeof fifth !== "string")
        throw new Error("checkpoint_value_invalid");
      bindingKey = fifth;
      if (sixth !== undefined && typeof sixth !== "string")
        throw new Error("checkpoint_value_invalid");
      projectID = sixth;
    } else {
      if (typeof second !== "string")
        throw new Error("checkpoint_value_invalid");
      if (isCheckpointState(third)) {
        state = third;
        if (fourth !== undefined && typeof fourth !== "string")
          throw new Error("checkpoint_value_invalid");
        lastMessageID = fourth;
        if (typeof fifth === "boolean") failed = fifth;
        else if (typeof fifth === "string") projectID = fifth;
        if (typeof sixth === "boolean") failed = sixth;
        else if (typeof sixth === "string") projectID = sixth;

        const direct = this.checkpointRow(second, firstID, projectID);
        const swapped = this.checkpointRow(firstID, second, projectID);
        if (direct || (!swapped && this.hasBinding(second, projectID))) {
          sessionID = firstID;
          bindingKey = second;
        } else {
          sessionID = second;
          bindingKey = firstID;
        }
      } else if (typeof third === "string" && isCheckpointState(fourth)) {
        projectID = third;
        state = fourth;
        if (fifth !== undefined && typeof fifth !== "string")
          throw new Error("checkpoint_value_invalid");
        lastMessageID = fifth;
        if (sixth !== undefined && typeof sixth !== "boolean")
          throw new Error("checkpoint_value_invalid");
        failed = sixth ?? false;
        const direct = this.checkpointRow(second, firstID, projectID);
        if (direct || this.hasBinding(second, projectID)) {
          sessionID = firstID;
          bindingKey = second;
        } else {
          sessionID = second;
          bindingKey = firstID;
        }
      } else {
        throw new Error("checkpoint_value_invalid");
      }
    }

    if (!bindingKey) {
      const row = this.uniqueCheckpointForSession(sessionID);
      if (!row) throw new Error(`checkpoint ${sessionID} not found`);
      bindingKey = row.binding_key;
      projectID = row.project_id;
    }
    const checkpoint = this.checkpointRow(bindingKey, sessionID, projectID);
    if (!checkpoint) {
      if (!this.hasBinding(bindingKey, projectID))
        throw new Error("binding_conflict");
      throw new Error(`checkpoint ${sessionID} not found`);
    }
    projectID = checkpoint.project_id;
    const now = Date.now();
    const result = this.db
      .query(
        `
      UPDATE capture_checkpoints
         SET state = ?,
             last_message_id = COALESCE(?, last_message_id),
             last_reconciled_at = ?,
             next_reconcile_at = ?,
             failure_count = CASE WHEN ? THEN failure_count + 1 ELSE 0 END,
             updated_at = ?
       WHERE binding_key = ? AND session_id = ? AND project_id = ?
    `,
      )
      .run(
        state,
        lastMessageID ?? null,
        now,
        now + (failed ? 5_000 : 30_000),
        failed,
        now,
        bindingKey,
        sessionID,
        projectID,
      );
    if (result.changes === 0)
      throw new Error(`checkpoint ${sessionID} not found`);
  }

  getCheckpoint(
    sessionID: string,
    bindingKey?: string,
    projectID?: string,
  ):
    | {
        sessionID: string;
        lastMessageID?: string;
        state: CheckpointState;
      }
    | undefined {
    let row = bindingKey
      ? this.checkpointRow(bindingKey, sessionID, projectID)
      : undefined;
    if (!row && bindingKey && !this.hasBinding(bindingKey, projectID)) {
      row = this.checkpointRow(sessionID, bindingKey, projectID);
    }
    if (!bindingKey) row = this.uniqueCheckpointForSession(sessionID);
    return row
      ? {
          sessionID: row.session_id,
          ...(row.last_message_id
            ? { lastMessageID: row.last_message_id }
            : {}),
          state: row.state,
        }
      : undefined;
  }

  ingest(
    input: unknown,
    mode: CaptureMode,
    options: {
      allowedKinds?: readonly string[];
      minConfidence?: number;
      denylist?: readonly string[];
    } = {},
  ): CaptureIngestResult {
    const parsed = parseCaptureEvent(input);
    if (captureKeyForEvent(parsed) !== parsed.idempotencyKey) {
      throw new Error("idempotency_conflict");
    }
    if (!this.binding(parsed.bindingKey, parsed.projectID))
      throw new Error("binding_conflict");
    const prepared = prepareForPersistence(parsed, options.denylist);
    const now = Date.now();
    let result: CaptureIngestResult = {
      outcome: prepared.quarantined ? "quarantined" : "shadowed",
      idempotencyKey: parsed.idempotencyKey,
    };

    this.db.transaction(() => {
      const inserted = this.db
        .query(
          `
        INSERT INTO capture_events
          (idempotency_key, contract, project_id, binding_key, event_kind,
           source_session_id, source_message_id, source_ordinal, source_tool_call_id,
           payload_json, payload_hash, redaction_version, state, attempt_count,
           generation, created_at, updated_at, processed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `,
        )
        .run(
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
          .query(
            `SELECT contract, project_id, binding_key, event_kind, source_session_id,
                    source_message_id, source_ordinal, source_tool_call_id,
                    payload_json, payload_hash, redaction_version, note_id
               FROM capture_events WHERE idempotency_key = ?`,
          )
          .get(parsed.idempotencyKey) as CaptureRow | undefined;
        if (
          !existing ||
          !samePersistedCapture(
            existing,
            prepared.event,
            prepared.payload,
            prepared.payloadHash,
          )
        ) {
          throw new Error("idempotency_conflict");
        }
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

  runRetention(
    now = Date.now(),
    batchSize = 100,
  ): { summarized: number; deleted: number; checkpoints: number } {
    const terminalCutoff = now - 30 * 24 * 60 * 60 * 1_000;
    const quarantineCutoff = now - 7 * 24 * 60 * 60 * 1_000;
    const summarized = this.db
      .query(
        `
      UPDATE capture_events
         SET payload_json = NULL, updated_at = ?
       WHERE idempotency_key IN (
         SELECT idempotency_key FROM capture_events
          WHERE state IN ('materialized','duplicate','ignored','rejected','shadowed','review','failed','dead')
            AND processed_at < ? AND payload_json IS NOT NULL
          ORDER BY processed_at LIMIT ?
       )
    `,
      )
      .run(now, terminalCutoff, batchSize).changes;
    const deleted = this.db
      .query(
        `
      DELETE FROM capture_events
       WHERE idempotency_key IN (
         SELECT idempotency_key FROM capture_events
          WHERE state = 'quarantined' AND processed_at < ?
          ORDER BY processed_at LIMIT ?
       )
    `,
      )
      .run(quarantineCutoff, batchSize).changes;
    const checkpoints = this.db
      .query(
        `
      DELETE FROM capture_checkpoints
       WHERE (binding_key, session_id) IN (
         SELECT binding_key, session_id FROM capture_checkpoints
           WHERE (state IN ('idle','closed') AND updated_at < ?)
              OR (state = 'unavailable' AND updated_at < ?)
           ORDER BY updated_at LIMIT ?
       )
    `,
      )
      .run(terminalCutoff, quarantineCutoff, batchSize).changes;
    return { summarized, deleted, checkpoints };
  }

  runRetentionBacklog(
    now = Date.now(),
    batchSize = 100,
    maxBatches = 10,
  ): { summarized: number; deleted: number; checkpoints: number } {
    const total = { summarized: 0, deleted: 0, checkpoints: 0 };
    for (let batch = 0; batch < maxBatches; batch++) {
      const result = this.runRetention(now, batchSize);
      total.summarized += result.summarized;
      total.deleted += result.deleted;
      total.checkpoints += result.checkpoints;
      if (
        result.summarized < batchSize &&
        result.deleted < batchSize &&
        result.checkpoints < batchSize
      )
        break;
    }
    return total;
  }

  private materialize(
    event: CaptureEventV1,
    candidate: MemoryCandidateV1,
    now: number,
  ): CaptureIngestResult {
    const subjectKey = candidate.subjectKey
      ? normalizeSubjectKey(candidate.subjectKey)
      : null;
    const hash = noteContentHash(
      candidate.kind,
      candidate.title,
      candidate.summary,
      candidate.content,
    );
    const existing = subjectKey
      ? (this.db
          .query(
            `SELECT * FROM notes
              WHERE project_id = ? AND kind = ? AND subject_key = ? AND status = 'active'`,
          )
          .get(event.projectID, candidate.kind, subjectKey) as
          NoteRow | undefined)
      : undefined;
    if (existing?.content_hash === hash) {
      this.finishEvent(event.idempotencyKey, "duplicate", existing.id, now);
      return {
        outcome: "duplicate",
        idempotencyKey: event.idempotencyKey,
        noteID: existing.id,
      };
    }
    if (existing) {
      if (
        candidate.intent !== "supersede" ||
        candidate.targetNoteID !== existing.id ||
        candidate.confidence < 0.95
      ) {
        this.finishEvent(event.idempotencyKey, "review", existing.id, now);
        return {
          outcome: "review",
          idempotencyKey: event.idempotencyKey,
          noteID: existing.id,
        };
      }
      this.db
        .query(
          `
        UPDATE notes
           SET status = 'superseded', current_revision = current_revision + 1, updated_at = ?
         WHERE project_id = ? AND id = ? AND status = 'active'
      `,
        )
        .run(now, event.projectID, existing.id);
      this.recordRevision(event, existing.id, now);
      const id = this.insertCapturedNote(
        event,
        candidate,
        subjectKey,
        existing.id,
        hash,
        now,
      );
      this.db
        .query(
          `
        INSERT INTO note_edges
          (id, project_id, source_id, target_id, predicate, created_at)
        VALUES (?, ?, ?, ?, 'SUPERSEDES', ?)
      `,
        )
        .run(randomUUID(), event.projectID, id, existing.id, now);
      for (const backend of this.indexBackends) {
        this.enqueueOutbox(
          backend,
          "delete-note",
          event.projectID,
          existing.id,
          existing.current_revision + 1,
          null,
          now,
        );
        const note = this.db
          .query("SELECT * FROM notes WHERE id = ?")
          .get(id) as NoteRow;
        const derived = derivedHash(note);
        if (derived)
          this.enqueueOutbox(
            backend,
            "upsert-note",
            event.projectID,
            id,
            1,
            derived,
            now,
          );
      }
      this.finishEvent(event.idempotencyKey, "materialized", id, now);
      return {
        outcome: "materialized",
        idempotencyKey: event.idempotencyKey,
        noteID: id,
      };
    }
    if (candidate.intent === "supersede") {
      const target = candidate.targetNoteID
        ? (this.db
            .query("SELECT id FROM notes WHERE project_id = ? AND id = ?")
            .get(event.projectID, candidate.targetNoteID) as { id: string } | undefined)
        : undefined;
      this.finishEvent(
        event.idempotencyKey,
        "review",
        target?.id ?? null,
        now,
      );
      return {
        outcome: "review",
        idempotencyKey: event.idempotencyKey,
        ...(target ? { noteID: target.id } : {}),
      };
    }
    const id = this.insertCapturedNote(
      event,
      candidate,
      subjectKey,
      null,
      hash,
      now,
    );
    const note = this.db
      .query("SELECT * FROM notes WHERE id = ?")
      .get(id) as NoteRow;
    for (const backend of this.indexBackends) {
      const derived = derivedHash(note);
      if (derived)
        this.enqueueOutbox(
          backend,
          "upsert-note",
          event.projectID,
          id,
          1,
          derived,
          now,
        );
    }
    this.finishEvent(event.idempotencyKey, "materialized", id, now);
    return {
      outcome: "materialized",
      idempotencyKey: event.idempotencyKey,
      noteID: id,
    };
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
    this.db
      .query(
        `
      INSERT INTO notes
        (id, project_id, kind, title, summary, content, size_class, pinned, status,
         supersedes_id, current_revision, subject_key, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, 1, ?, ?, ?, ?)
    `,
      )
      .run(
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

  private recordRevision(
    event: CaptureEventV1,
    noteID: string,
    now: number,
  ): void {
    const note = this.db
      .query("SELECT * FROM notes WHERE project_id = ? AND id = ?")
      .get(event.projectID, noteID) as NoteRow;
    const provenanceID = randomUUID();
    this.db
      .query(
        `
      INSERT INTO note_provenance
        (id, project_id, note_id, source_type, capture_event_id, source_session_id,
         source_message_id, source_ordinal, source_tool_call_id, redaction_version,
         extractor_version, confidence, created_at)
      VALUES (?, ?, ?, 'opencode-capture', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
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
    if (
      revision < 1 ||
      (operation === "upsert-note" && !contentHash) ||
      (operation === "delete-note" && contentHash !== null)
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
      ON CONFLICT DO NOTHING
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

  private finishEvent(
    idempotencyKey: string,
    state: CaptureIngestResult["outcome"],
    noteID: string | null,
    now: number,
  ): void {
    this.db
      .query(
        `
      UPDATE capture_events
         SET state = ?, note_id = ?, updated_at = ?, processed_at = ?
       WHERE idempotency_key = ?
    `,
      )
      .run(state, noteID, now, now, idempotencyKey);
  }

  private binding(
    bindingKey: string,
    projectID: string,
  ): BindingRow | undefined {
    return this.db
      .query(
        "SELECT * FROM project_bindings WHERE binding_key = ? AND project_id = ?",
      )
      .get(bindingKey, projectID) as BindingRow | undefined;
  }

  private hasBinding(bindingKey: string, projectID?: string): boolean {
    return Boolean(
      projectID === undefined
        ? this.db
            .query(
              "SELECT binding_key FROM project_bindings WHERE binding_key = ? LIMIT 1",
            )
            .get(bindingKey)
        : this.binding(bindingKey, projectID),
    );
  }

  private checkpointRow(
    bindingKey: string,
    sessionID: string,
    projectID?: string,
  ): CheckpointIdentityRow | undefined {
    const suffix = projectID === undefined ? "" : " AND c.project_id = ?";
    const args =
      projectID === undefined
        ? [bindingKey, sessionID]
        : [bindingKey, sessionID, projectID];
    return this.db
      .query(
        `SELECT c.session_id, c.binding_key, c.project_id, c.last_message_id, c.state
           FROM capture_checkpoints c
           JOIN project_bindings b
             ON b.binding_key = c.binding_key AND b.project_id = c.project_id
          WHERE c.binding_key = ? AND c.session_id = ?${suffix}`,
      )
      .get(...args) as CheckpointIdentityRow | undefined;
  }

  private uniqueCheckpointForSession(
    sessionID: string,
  ): CheckpointIdentityRow | undefined {
    const rows = this.db
      .query(
        `SELECT c.session_id, c.binding_key, c.project_id, c.last_message_id, c.state
           FROM capture_checkpoints c
           JOIN project_bindings b
             ON b.binding_key = c.binding_key AND b.project_id = c.project_id
          WHERE c.session_id = ?
          LIMIT 2`,
      )
      .all(sessionID) as CheckpointIdentityRow[];
    if (rows.length > 1) throw new Error("checkpoint_binding_conflict");
    return rows[0];
  }
}

function prepareForPersistence(
  event: CaptureEventV1,
  denylist?: readonly string[],
) {
  const copy = structuredClone(event);
  let replacements = 0;
  let truncated = copy.redaction.truncated;
  let quarantined = event.redaction.policyVersion.endsWith("/quarantined");
  if (copy.candidate) {
    for (const field of [
      "title",
      "summary",
      "content",
      "subjectKey",
    ] as const) {
      const value = copy.candidate[field];
      if (typeof value !== "string") continue;
      const maximum =
        field === "title" || field === "subjectKey"
          ? 240
          : field === "summary"
            ? 1_200
            : 4_800;
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
    payloadHash: capturePayloadHash(validated),
    quarantined,
    additionalReplacements: replacements,
  };
}

function bindingResult(
  existing: BindingRow,
  input: ProjectBindingInput,
  bindingKey: string,
  canonicalPathHash: string,
): { ok: true; bindingKey: string; projectID: string } {
  const legacyCanonicalPathHash = createHash("sha256")
    .update(input.canonicalDirectory, "utf8")
    .digest("hex");
  const legacyBindingKey = hashTuple("project-binding", 2, [
    "opencode-v2",
    input.opencodeProjectID,
    input.workspaceID ?? "",
    legacyCanonicalPathHash,
  ]);
  if (
    existing.project_id !== input.memoryProjectID ||
    !(
      (existing.binding_key === bindingKey &&
        existing.canonical_path_hash === canonicalPathHash) ||
      (existing.binding_key === legacyBindingKey &&
        existing.canonical_path_hash === legacyCanonicalPathHash)
    )
  ) {
    throw new Error("binding_conflict");
  }
  return {
    ok: true,
    bindingKey: existing.binding_key,
    projectID: existing.project_id,
  };
}

function isCheckpointState(value: unknown): value is CheckpointState {
  return (
    value === "active" ||
    value === "idle" ||
    value === "unavailable" ||
    value === "closed"
  );
}

function captureKeyForEvent(event: CaptureEventV1): string {
  const source = event.source;
  if (event.kind === "user-candidate") {
    if (typeof source.messageID !== "string")
      throw new Error("idempotency_conflict");
    return captureIdempotencyKey({
      kind: "user",
      bindingKey: event.bindingKey,
      sessionID: source.sessionID,
      messageID: source.messageID,
    });
  }
  if (event.kind === "assistant-candidate") {
    if (typeof source.messageID !== "string" || source.ordinal === undefined) {
      throw new Error("idempotency_conflict");
    }
    return captureIdempotencyKey({
      kind: "assistant",
      bindingKey: event.bindingKey,
      sessionID: source.sessionID,
      assistantMessageID: source.messageID,
      ordinal: source.ordinal,
    });
  }
  if (event.kind === "session-summary") {
    if (typeof source.messageID !== "string")
      throw new Error("idempotency_conflict");
    return captureIdempotencyKey({
      kind: "summary",
      bindingKey: event.bindingKey,
      sessionID: source.sessionID,
      checkpointMessageID: source.messageID,
    });
  }
  if (
    typeof source.messageID !== "string" ||
    typeof source.toolCallID !== "string"
  ) {
    throw new Error("idempotency_conflict");
  }
  if (
    !event.signal ||
    (event.signal.status !== "completed" && event.signal.status !== "error")
  ) {
    throw new Error("idempotency_conflict");
  }
  return captureIdempotencyKey({
    kind: "tool",
    bindingKey: event.bindingKey,
    sessionID: source.sessionID,
    assistantMessageID: source.messageID,
    toolCallID: source.toolCallID,
    terminalStatus: event.signal.status,
  });
}

function samePersistedCapture(
  existing: CaptureRow,
  event: CaptureEventV1,
  payload: string | null,
  payloadHash: string | null,
): boolean {
  const retainedLegacyPayload = existing.payload_json === null && existing.payload_hash === null;
  return (
    existing.contract === event.schema &&
    existing.project_id === event.projectID &&
    existing.binding_key === event.bindingKey &&
    existing.event_kind === event.kind &&
    existing.source_session_id === event.source.sessionID &&
    existing.source_message_id === (event.source.messageID ?? null) &&
    existing.source_ordinal === (event.source.ordinal ?? null) &&
    existing.source_tool_call_id === (event.source.toolCallID ?? null) &&
    (retainedLegacyPayload ||
      (sameCapturePayload(existing.payload_json, existing.payload_hash, payload, payloadHash) &&
        existing.redaction_version === REDACTION_POLICY_VERSION))
  );
}

function sameCapturePayload(
  existingPayload: string | null,
  existingHash: string | null,
  payload: string | null,
  payloadHash: string | null,
): boolean {
  if (existingHash !== null && existingHash === payloadHash) return true;
  if (existingPayload === null || payload === null) return false;
  try {
    const existing = JSON.parse(existingPayload) as { source?: Record<string, unknown> };
    const candidate = JSON.parse(payload) as { source?: Record<string, unknown> };
    if (!existing.source || !candidate.source) return false;
    existing.source.observedAt = 0;
    candidate.source.observedAt = 0;
    return JSON.stringify(existing) === JSON.stringify(candidate);
  } catch {
    return false;
  }
}

function capturePayloadHash(event: CaptureEventV1): string {
  const canonical = structuredClone(event);
  canonical.source.observedAt = 0;
  return hashTuple("capture-payload", 2, [JSON.stringify(canonical)]);
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

interface CheckpointIdentityRow {
  session_id: string;
  binding_key: string;
  project_id: string;
  last_message_id: string | null;
  state: CheckpointState;
}

interface CaptureRow {
  contract: string;
  project_id: string;
  binding_key: string;
  event_kind: string;
  source_session_id: string;
  source_message_id: string | null;
  source_ordinal: number | null;
  source_tool_call_id: string | null;
  payload_json: string | null;
  payload_hash: string | null;
  redaction_version: string;
  note_id: string | null;
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
