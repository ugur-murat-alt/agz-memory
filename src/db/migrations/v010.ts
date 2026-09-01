import { createHash } from "crypto";
import type { Database } from "bun:sqlite";
import { CAPTURE_SCHEMA, parseCaptureEvent } from "../../capture/contract";
import { captureEventsTable, SCHEMA_TABLES } from "../schema";

export function migrateV9ToV10(db: Database): void {
  const payloads = db
    .query("SELECT idempotency_key, payload_json FROM capture_events WHERE payload_json IS NOT NULL")
    .all() as Array<{ idempotency_key: string; payload_json: string }>;
  const migratedPayloads = payloads.map((row) => {
    const event = JSON.parse(row.payload_json) as unknown;
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error(`capture event ${row.idempotency_key} payload is not an object`);
    }
    (event as Record<string, unknown>).schema = CAPTURE_SCHEMA;
    const payload = JSON.stringify(parseCaptureEvent(event));
    return {
      idempotencyKey: row.idempotency_key,
      payload,
      payloadHash: createHash("sha256").update(payload, "utf8").digest("hex"),
    };
  });
  db.exec("DROP TABLE IF EXISTS capture_events_v10");
  db.exec(captureEventsTable("capture_events_v10"));
  db.query(`
    INSERT INTO capture_events_v10
      (idempotency_key, contract, project_id, binding_key, event_kind,
       source_session_id, source_message_id, source_ordinal, source_tool_call_id,
       payload_json, payload_hash, redaction_version, state, attempt_count,
       note_id, last_error_code, generation, created_at, updated_at, processed_at)
    SELECT idempotency_key, ?, project_id, binding_key, event_kind,
           source_session_id, source_message_id, source_ordinal, source_tool_call_id,
           payload_json, payload_hash, redaction_version, state, attempt_count,
           note_id, last_error_code, generation, created_at, updated_at, processed_at
      FROM capture_events
  `).run(CAPTURE_SCHEMA);
  const updatePayload = db.query(`
    UPDATE capture_events_v10
       SET payload_json = ?, payload_hash = ?
     WHERE idempotency_key = ?
  `);
  for (const row of migratedPayloads) {
    updatePayload.run(row.payload, row.payloadHash, row.idempotencyKey);
  }
  db.exec(`
    DROP TABLE capture_events;
    ALTER TABLE capture_events_v10 RENAME TO capture_events;
  `);
  db.exec(SCHEMA_TABLES);
  db.query("DELETE FROM schema_state").run();
  db.query("INSERT INTO schema_state(version) VALUES (10)").run();
}
