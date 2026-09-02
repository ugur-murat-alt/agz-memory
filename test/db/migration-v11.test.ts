import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CAPTURE_SCHEMA, SUPPORTED_OPENCODE_VERSION } from "../../src/capture/contract";
import { captureIdempotencyKey } from "../../src/capture/identity";
import { openMemoryDatabase } from "../../src/db";
import { doctorDatabase } from "../../src/admin/doctor";
import { hashTuple } from "../../src/hash";
import { MemoryStore } from "../../src/store";
import { CaptureStore } from "../../src/store/capture";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const PROVENANCE_ID = "33333333-3333-4333-8333-333333333333";
const LEGACY_BINDING_KEY = "a".repeat(64);
const CANONICAL_DIRECTORY = "/preserved-v10";

describe("schema v11 migration", () => {
  test("opens schema v10 data as v11 without losing the project or note", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-v10-v11-"));
    const path = join(directory, "memory.sqlite");
    await createV10Fixture(path);

    try {
      const opened = openMemoryDatabase(path);
      try {
        expect(opened.db.query("SELECT version FROM schema_state").all()).toEqual([{ version: 11 }]);
        expect(
          opened.db
            .query("SELECT project_id, id, title, content FROM notes WHERE project_id = ? AND id = ?")
            .get(PROJECT_ID, NOTE_ID),
        ).toEqual({
          project_id: PROJECT_ID,
          id: NOTE_ID,
          title: "  preserved  ",
          content: "  preserved content  ",
        });
        const binding = new CaptureStore(opened.db).bindProject({
          memoryProjectID: PROJECT_ID,
          opencodeProjectID: "preserved-project",
          canonicalDirectory: CANONICAL_DIRECTORY,
        });
        expect(binding.bindingKey).toBe(
          hashTuple("project-binding", 2, [
            "opencode-v2",
            "preserved-project",
            "",
            createHash("sha256").update(CANONICAL_DIRECTORY).digest("hex"),
          ]),
        );
        expect(
          opened.db
            .query(
              "SELECT last_message_id FROM capture_checkpoints WHERE binding_key = ? AND session_id = ?",
            )
            .get(binding.bindingKey, "legacy-checkpoint"),
        ).toEqual({ last_message_id: null });
        expect(new MemoryStore(opened.db).update(PROJECT_ID, { id: NOTE_ID, kind: "context" }).ok).toBe(true);
        expect(
          opened.db
            .query("SELECT title, summary, content FROM notes WHERE project_id = ? AND id = ?")
            .get(PROJECT_ID, NOTE_ID),
        ).toEqual({
          title: "  preserved  ",
          summary: "  preserved summary  ",
          content: "  preserved content  ",
        });
      } finally {
        opened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("normalizes valid v10 tombstones and retained payloadless tool signals", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-v10-tombstones-"));
    const path = join(directory, "memory.sqlite");
    await createV10Fixture(path);
    const deletedProjectID = "44444444-4444-4444-8444-444444444444";
    const bindingKey = "b".repeat(64);
    const legacyCaptures = (["completed", "error"] as const).map((status) => ({
      status,
      messageID: `message-${status}`,
      toolCallID: `tool-${status}`,
      key: legacyToolCaptureKey(
        bindingKey,
        "session",
        `message-${status}`,
        `tool-${status}`,
        status,
      ),
    }));
    const db = new Database(path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.query("INSERT INTO projects VALUES (?, 'Deleted', 'deleted', 1, 1)").run(deletedProjectID);
      db.query(`
        INSERT INTO index_outbox
          (backend, operation, project_id, note_id, revision, content_hash,
           state, attempt_count, available_at, created_at, completed_at)
        VALUES ('historical', 'upsert-note', ?, ?, 1, ?, 'pending', 0, 1, 1, NULL)
      `).run(PROJECT_ID, NOTE_ID, "f".repeat(64));
      db.query(`
        INSERT INTO index_outbox
          (backend, operation, project_id, note_id, revision, content_hash,
           state, attempt_count, available_at, created_at)
        VALUES ('test', 'purge-project', ?, NULL, NULL, NULL, 'leased', 0, 1, 1)
      `).run(deletedProjectID);
      db.query(`
        INSERT INTO index_outbox
          (backend, operation, project_id, note_id, revision, content_hash,
           state, attempt_count, available_at, lease_owner, lease_expires_at, created_at, completed_at)
        VALUES ('test', 'purge-project', ?, NULL, NULL, NULL, 'pending', 0, 1, 'stale', 2, 1, NULL)
      `).run(deletedProjectID);
      db.query(`
        INSERT INTO index_outbox
          (backend, operation, project_id, note_id, revision, content_hash,
           state, attempt_count, available_at, created_at, completed_at)
        VALUES ('test', 'purge-project', ?, NULL, NULL, NULL, 'succeeded', 1, 1, 1, 1)
      `).run(deletedProjectID);
      db.query("DELETE FROM projects WHERE id = ?").run(deletedProjectID);
      db.query(`
        INSERT INTO index_outbox
          (backend, operation, project_id, note_id, revision, content_hash,
           state, attempt_count, available_at, created_at)
        VALUES ('test', 'delete-note', ?, ?, 1, ?, 'succeeded', 1, 1, 1)
      `).run(PROJECT_ID, NOTE_ID, "d".repeat(64));
      db.query("DELETE FROM notes WHERE project_id = ? AND id = ?").run(PROJECT_ID, NOTE_ID);
      db.query(`
        INSERT INTO project_bindings
          (binding_key, project_id, source, source_project_id, workspace_id,
           canonical_path_hash, created_at, updated_at)
        VALUES (?, ?, 'opencode-v2', 'legacy-project', '', ?, 1, 1)
      `).run(bindingKey, PROJECT_ID, "e".repeat(64));
      const insertCapture = db.query(`
        INSERT INTO capture_events
          (idempotency_key, contract, project_id, binding_key, event_kind,
           source_session_id, source_message_id, source_tool_call_id,
           payload_json, payload_hash, redaction_version, state, attempt_count,
           generation, created_at, updated_at, processed_at)
        VALUES (?, 'agz-memory.capture/1', ?, ?, 'tool-signal',
                'session', ?, ?, NULL, NULL, 'redaction/1',
                 'shadowed', 0, 0, 1, 1, 1)
      `);
      for (const capture of legacyCaptures) {
        insertCapture.run(
          capture.key,
          PROJECT_ID,
          bindingKey,
          capture.messageID,
          capture.toolCallID,
        );
      }
      db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } finally {
      db.close();
    }

    try {
      const opened = openMemoryDatabase(path);
      try {
        const outbox = opened.db
          .query("SELECT operation, operation_key, project_id, content_hash, generation, state, lease_owner, lease_expires_at, completed_at, length(operation_key) AS key_length FROM index_outbox ORDER BY id")
          .all() as Array<Record<string, unknown>>;
        expect(outbox.map(({ operation_key: _operationKey, ...row }) => row)).toEqual([
          { operation: "upsert-note", project_id: PROJECT_ID, content_hash: "f".repeat(64), generation: 0, state: "succeeded", lease_owner: null, lease_expires_at: null, completed_at: 1, key_length: 64 },
          { operation: "purge-project", project_id: deletedProjectID, content_hash: null, generation: 0, state: "pending", lease_owner: null, lease_expires_at: null, completed_at: null, key_length: 64 },
          { operation: "purge-project", project_id: deletedProjectID, content_hash: null, generation: 1, state: "pending", lease_owner: null, lease_expires_at: null, completed_at: null, key_length: 64 },
          { operation: "purge-project", project_id: deletedProjectID, content_hash: null, generation: 0, state: "succeeded", lease_owner: null, lease_expires_at: null, completed_at: 1, key_length: 64 },
          { operation: "delete-note", project_id: PROJECT_ID, content_hash: null, generation: 0, state: "succeeded", lease_owner: null, lease_expires_at: null, completed_at: null, key_length: 64 },
        ]);
        expect(outbox[1]!.operation_key).not.toBe(outbox[2]!.operation_key);
        expect(outbox[1]!.operation_key).toBe(outbox[3]!.operation_key);
        const report = doctorDatabase(opened.db);
        expect(report.ok).toBe(true);
        expect(report.invariants.outboxOperationKeyMismatches).toBe(0);
        expect(opened.db.query(
          "SELECT contract, payload_json, payload_hash FROM capture_events ORDER BY source_tool_call_id",
        ).all()).toEqual([
          { contract: "agz-memory.capture/2", payload_json: null, payload_hash: null },
          { contract: "agz-memory.capture/2", payload_json: null, payload_hash: null },
        ]);
        const migratedBinding = opened.db.query(
          "SELECT binding_key FROM project_bindings WHERE source_project_id = 'legacy-project'",
        ).get() as { binding_key: string };
        const migratedEvents = opened.db.query(
          "SELECT idempotency_key, source_message_id, source_tool_call_id FROM capture_events ORDER BY source_tool_call_id",
        ).all() as Array<{
          idempotency_key: string;
          source_message_id: string;
          source_tool_call_id: string;
        }>;
        const capture = new CaptureStore(opened.db);
        for (const legacy of legacyCaptures) {
          const idempotencyKey = captureIdempotencyKey({
            kind: "tool",
            bindingKey: migratedBinding.binding_key,
            sessionID: "session",
            assistantMessageID: legacy.messageID,
            toolCallID: legacy.toolCallID,
            terminalStatus: legacy.status,
          });
          expect(migratedEvents).toContainEqual({
            idempotency_key: idempotencyKey,
            source_message_id: legacy.messageID,
            source_tool_call_id: legacy.toolCallID,
          });
          expect(capture.ingest({
            schema: CAPTURE_SCHEMA,
            idempotencyKey,
            projectID: PROJECT_ID,
            bindingKey: migratedBinding.binding_key,
            kind: "tool-signal",
            source: {
              system: "opencode-v2",
              opencodeVersion: SUPPORTED_OPENCODE_VERSION,
              pluginVersion: "0.5.0",
              sessionID: "session",
              messageID: legacy.messageID,
              toolCallID: legacy.toolCallID,
              observedAt: 2,
            },
            signal: { tool: "bash", status: legacy.status },
            redaction: { policyVersion: "redaction/1", replacements: 0, truncated: false },
          }, "shadow").outcome).toBe("duplicate");
        }
      } finally {
        opened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function legacyToolCaptureKey(
  bindingKey: string,
  sessionID: string,
  assistantMessageID: string,
  toolCallID: string,
  status: "completed" | "error",
): string {
  return createHash("sha256")
    .update(
      ["capture/1", "tool", bindingKey, sessionID, assistantMessageID, toolCallID, status]
        .join("\0"),
      "utf8",
    )
    .digest("hex");
}

async function createV10Fixture(path: string): Promise<void> {
  const schema = await Bun.file(join(import.meta.dir, "../fixtures/schema-v10.sql")).text();
  const hash = createHash("sha256")
    .update("fact\0  preserved  \0  preserved summary  \0  preserved content  ", "utf8")
    .digest("hex");
  const db = new Database(path, { create: true });
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
    db.exec(schema);
    db.query("INSERT INTO projects VALUES (?, 'Preserve v10', 'preserve v10', 1, 1)").run(PROJECT_ID);
    const canonicalPathHash = createHash("sha256").update(CANONICAL_DIRECTORY).digest("hex");
    db.query(`
      INSERT INTO project_bindings
        (binding_key, project_id, source, source_project_id, workspace_id,
         canonical_path_hash, created_at, updated_at)
      VALUES (?, ?, 'opencode-v2', 'preserved-project', '', ?, 1, 1)
    `).run(LEGACY_BINDING_KEY, PROJECT_ID, canonicalPathHash);
    db.query(`
      INSERT INTO capture_checkpoints
        (session_id, binding_key, project_id, state, last_message_id,
         last_reconciled_at, next_reconcile_at, failure_count, created_at, updated_at)
      VALUES ('legacy-checkpoint', ?, ?, 'active', 'legacy-prompt-watermark', 1, 1, 0, 1, 1)
    `).run(LEGACY_BINDING_KEY, PROJECT_ID);
    db.query(`
      INSERT INTO notes
        (id, project_id, kind, title, summary, content, size_class, pinned, status,
         supersedes_id, current_revision, subject_key, content_hash, created_at, updated_at)
       VALUES (?, ?, 'fact', '  preserved  ', '  preserved summary  ', '  preserved content  ',
              'inline', 0, 'active', NULL, 1, NULL, ?, 1, 1)
    `).run(NOTE_ID, PROJECT_ID, hash);
    db.query(`
      INSERT INTO note_provenance (id, project_id, note_id, source_type, created_at)
      VALUES (?, ?, ?, 'mcp-manual', 1)
    `).run(PROVENANCE_ID, PROJECT_ID, NOTE_ID);
    db.query(`
      INSERT INTO note_revisions
        (project_id, note_id, revision, kind, title, summary, content, size_class,
         pinned, status, supersedes_id, subject_key, content_hash, provenance_id, created_at)
       VALUES (?, ?, 1, 'fact', '  preserved  ', '  preserved summary  ', '  preserved content  ',
              'inline', 0, 'active', NULL, NULL, ?, ?, 1)
    `).run(PROJECT_ID, NOTE_ID, hash, PROVENANCE_ID);
    expect(db.query("SELECT version FROM schema_state").get()).toEqual({ version: 10 });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}
