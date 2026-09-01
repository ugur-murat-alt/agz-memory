import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CAPTURE_SCHEMA, parseCaptureEvent } from "../../src/capture/contract";
import { openMemoryDatabase } from "../../src/db";
import { createSchema } from "../../src/db/schema";

describe("schema v10 migration", () => {
  test("preserves v9 capture rows while replacing their retired contract", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-v9-v10-"));
    const path = join(directory, "memory.sqlite");
    createV9Database(path);

    const opened = openMemoryDatabase(path);
    expect(opened.db.query("SELECT version FROM schema_state").all()).toEqual([{ version: 10 }]);
    const row = opened.db
      .query("SELECT idempotency_key, contract, state, payload_json, payload_hash FROM capture_events")
      .get() as {
      idempotency_key: string;
      contract: string;
      state: string;
      payload_json: string;
      payload_hash: string;
    };
    expect(row).toMatchObject({ contract: CAPTURE_SCHEMA, state: "shadowed" });
    expect(parseCaptureEvent(JSON.parse(row.payload_json)).schema).toBe(CAPTURE_SCHEMA);
    expect(createHash("sha256").update(row.payload_json, "utf8").digest("hex")).toBe(row.payload_hash);
    expect(
      (opened.db.query("SELECT sql FROM sqlite_master WHERE name = 'capture_events'").get() as { sql: string })
        .sql,
    ).toContain(CAPTURE_SCHEMA);
    opened.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

function createV9Database(path: string): void {
  const retiredSchema = ["opencode", "2", "-memory.capture/1"].join("");
  const eventID = "b".repeat(64);
  const bindingKey = "c".repeat(64);
  const payload = JSON.stringify({
    schema: retiredSchema,
    idempotencyKey: eventID,
    projectID: "11111111-1111-4111-8111-111111111111",
    bindingKey,
    kind: "user-candidate",
    source: {
      system: "opencode-v2",
      opencodeVersion: "0.0.0-beta-18743",
      pluginVersion: "0.3.0",
      sessionID: "session-1",
      messageID: "message-1",
      observedAt: 1,
    },
    candidate: {
      kind: "decision",
      title: "Migration",
      summary: "Preserve this capture payload",
      content: "Preserve this capture payload",
      intent: "create",
      confidence: 0.99,
      evidence: "verified-outcome",
    },
    redaction: { policyVersion: "redaction/1", replacements: 0, truncated: false },
  });
  const db = new Database(path, { create: true });
  createSchema(db);
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec(`
    DROP TABLE capture_events;
    CREATE TABLE capture_events (
      idempotency_key TEXT PRIMARY KEY,
      contract TEXT NOT NULL,
      project_id TEXT NOT NULL,
      binding_key TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      source_message_id TEXT,
      source_ordinal INTEGER,
      source_tool_call_id TEXT,
      payload_json TEXT,
      payload_hash TEXT,
      redaction_version TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      note_id TEXT,
      last_error_code TEXT,
      generation INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      processed_at INTEGER
    );
    UPDATE schema_state SET version = 9;
    INSERT INTO projects VALUES (
      '11111111-1111-4111-8111-111111111111', 'Migration', 'migration', 1, 1
    );
  `);
  db.query(`
    INSERT INTO project_bindings VALUES (
      ?, '11111111-1111-4111-8111-111111111111', 'opencode-v2',
      'project-1', '', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 1
    )
  `).run(bindingKey);
  db.query(`
    INSERT INTO capture_events
      (idempotency_key, contract, project_id, binding_key, event_kind,
       source_session_id, source_message_id, payload_json, payload_hash,
       redaction_version, state, created_at, updated_at)
    VALUES (?, ?, '11111111-1111-4111-8111-111111111111', ?,
            'user-candidate', 'session-1', 'message-1', ?, ?, 'redaction/1', 'shadowed', 1, 1)
  `).run(
    eventID,
    retiredSchema,
    bindingKey,
    payload,
    createHash("sha256").update(payload, "utf8").digest("hex"),
  );
  db.close();
}
