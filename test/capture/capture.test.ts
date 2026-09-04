import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openMemoryDatabase } from "../../src/db";
import { MemoryStore } from "../../src/store";
import { CaptureStore } from "../../src/store/capture";
import { captureIdempotencyKey } from "../../src/capture/identity";
import { extractExplicitUserCandidate } from "../../src/capture/policy";
import { projectAssistantParts } from "../../src/capture/projection";
import { redactText } from "../../src/capture/redact";
import {
  CAPTURE_SCHEMA,
  parseCaptureEvent,
  type CaptureEventV1,
  type MemoryCandidateV1,
} from "../../src/capture/contract";
import { PRODUCT_VERSION } from "../../src/version";
import { QuarantineKeyring } from "../../src/security/quarantine-key";
import { quarantinePrivacyReport } from "../../src/admin/quarantine";

describe("capture safety core", () => {
  test("uses stable native identity hashes and strict bounded events", () => {
    expect(
      captureIdempotencyKey({
        kind: "user",
        bindingKey: "binding",
        sessionID: "session",
        messageID: "message",
      }),
    ).toBe("ec3fcdf23623f36c05d150ac68751af68498be00facb401c3325cae5d85b71da");
    expect(
      captureIdempotencyKey({
        kind: "assistant",
        bindingKey: "binding",
        sessionID: "session",
        assistantMessageID: "assistant",
        ordinal: 7,
      }),
    ).toBe("9d1af203029bcbf7653dd1a5b39cad3b8b1be03cb746203f5e6e72a73d565a2e");
    expect(
      captureIdempotencyKey({
        kind: "tool",
        bindingKey: "binding",
        sessionID: "session",
        assistantMessageID: "assistant",
        toolCallID: "call",
        terminalStatus: "completed",
      }),
    ).toBe("2f2c3ed175819fb69d42cc6a476e5eace287b2fd877040a6fc765729e3eab58f");
    expect(
      captureIdempotencyKey({
        kind: "summary",
        bindingKey: "binding",
        sessionID: "session",
        checkpointMessageID: "checkpoint",
      }),
    ).toBe("357bcfc325c708247bf28cbd52c65ce30e6d68c66e2346c9178bf5bb5add1fd4");
    expect(() => parseCaptureEvent({ schema: "retired.capture/1" })).toThrow();
  });

  test("projects only text parts and redacts credentials before persistence", () => {
    expect(
      projectAssistantParts([
        { type: "reasoning", text: "hidden reasoning" },
        { type: "tool", input: { token: "raw" }, output: "raw tool output" },
        { type: "text", text: "safe terminal text" },
      ]).text,
    ).toBe("safe terminal text");
    const redacted = redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted.text).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted.replacements).toBe(1);
  });

  test("stores one event per native identity, quarantines private keys, and materializes explicit memory", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-capture-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    const memory = new MemoryStore(opened.db, ["fake@1"]);
    const projectID = memory.createProject("Capture").project!.projectID;
    const quarantineKeyring = new QuarantineKeyring(join(directory, "quarantine.keys"));
    const capture = new CaptureStore(opened.db, ["fake@1"], { quarantineKeyring });
    const binding = capture.bindProject({
      memoryProjectID: projectID,
      opencodeProjectID: "oc-project",
      canonicalDirectory: "/canonical/project",
    });
    capture.checkpoint("session-1", binding.bindingKey, projectID, "message-1");

    const candidate = extractExplicitUserCandidate("Tercihim: her zaman kısa yanıt ver.")!;
    const event = userEvent(projectID, binding.bindingKey, "session-1", "message-1", candidate);
    const first = capture.ingest(event, "auto-write");
    expect(first.outcome).toBe("materialized");
    expect(capture.ingest(event, "auto-write")).toMatchObject({ outcome: "duplicate", existing: true });
    expect((opened.db.query("SELECT COUNT(*) AS count FROM capture_events").get() as { count: number }).count).toBe(1);
    expect((opened.db.query("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count).toBe(1);

    const privateKey = "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----";
    const risky = userEvent(
      projectID,
      binding.bindingKey,
      "session-1",
      "message-2",
      { ...candidate, title: "Kararım", summary: privateKey, content: privateKey },
    );
    expect(capture.ingest(risky, "auto-write").outcome).toBe("quarantined");
    expect(capture.ingest(risky, "auto-write")).toMatchObject({ outcome: "duplicate", existing: true });
    quarantineKeyring.rotate();
    expect(capture.ingest(risky, "auto-write")).toMatchObject({ outcome: "duplicate", existing: true });
    const changedRisky = {
      ...structuredClone(risky),
      candidate: { ...risky.candidate!, content: `${privateKey}\nchanged` },
    };
    expect(() => capture.ingest(changedRisky, "auto-write")).toThrow("idempotency_conflict");
    const stored = opened.db
      .query("SELECT payload_json, payload_hash, redaction_version FROM capture_events WHERE idempotency_key = ?")
      .get(risky.idempotencyKey) as {
      payload_json: string | null;
      payload_hash: string | null;
      redaction_version: string;
    };
    expect(stored.payload_json).toBeNull();
    expect(stored.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.redaction_version).toMatch(
      /^redaction\/1;quarantine-key=[0-9a-f]{24};quarantine-digest=2$/,
    );
    expect(JSON.stringify(opened.db.query("SELECT * FROM capture_events").all())).not.toContain("abc123");
    const privacyReport = quarantinePrivacyReport(opened.db);
    expect(privacyReport).toMatchObject({
      quarantinedEvents: 1,
      keyedEvents: 1,
      unavailableKeyEvents: 0,
      legacyOrUnknownEvents: 0,
      digest: {
        algorithm: "HMAC-SHA256",
        input: "quarantine-source-identity-and-redacted-payload/2",
        storage: "capture_events.payload_hash",
      },
    });
    expect(privacyReport.keyIDs).toEqual([stored.redaction_version.slice(27, 51)]);
    expect(JSON.stringify(privacyReport)).not.toContain("abc123");
    opened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("fails closed when the quarantine keyring becomes insecure", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-capture-keyring-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    try {
      const memory = new MemoryStore(opened.db);
      const projectID = memory.createProject("Quarantine keyring").project!.projectID;
      const keyPath = join(directory, "quarantine.keys");
      const keyring = new QuarantineKeyring(keyPath);
      keyring.ensureActiveKey();
      chmodSync(keyPath, 0o644);
      const capture = new CaptureStore(opened.db, [], { quarantineKeyring: keyring });
      const binding = capture.bindProject({
        memoryProjectID: projectID,
        opencodeProjectID: "oc-project",
        canonicalDirectory: "/canonical/project",
      });
      const canary = "QUARANTINE_PRIVATE_CANARY_abcdefghijklmno";
      const candidate = extractExplicitUserCandidate("Kararım: karantinayı doğrula.")!;
      const risky = userEvent(projectID, binding.bindingKey, "session", "message", {
        ...candidate,
        summary: `-----BEGIN PRIVATE KEY-----\n${canary}\n-----END PRIVATE KEY-----`,
        content: `-----BEGIN PRIVATE KEY-----\n${canary}\n-----END PRIVATE KEY-----`,
      });
      expect(capture.ingest(risky, "shadow").outcome).toBe("quarantined");
      expect(() => capture.ingest(risky, "shadow")).toThrow("idempotency_conflict");
      const stored = opened.db
        .query("SELECT payload_json, payload_hash, redaction_version FROM capture_events WHERE idempotency_key = ?")
        .get(risky.idempotencyKey) as {
        payload_json: string | null;
        payload_hash: string | null;
        redaction_version: string;
      };
      expect(stored).toEqual({
        payload_json: null,
        payload_hash: null,
        redaction_version: "redaction/1;quarantine-key=unavailable;quarantine-digest=2",
      });
      expect(JSON.stringify(opened.db.query("SELECT * FROM capture_events").all())).not.toContain(canary);
      expect(JSON.stringify(quarantinePrivacyReport(opened.db))).not.toContain(canary);
    } finally {
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("atomically supersedes only an explicit matching target", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-supersede-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    const memory = new MemoryStore(opened.db);
    const projectID = memory.createProject("Supersede").project!.projectID;
    const capture = new CaptureStore(opened.db);
    const binding = capture.bindProject({
      memoryProjectID: projectID,
      opencodeProjectID: "oc-project",
      canonicalDirectory: "/canonical/project",
    });
    const initial = extractExplicitUserCandidate("Kararım: derleyici olarak Bun kullan.")!;
    const created = capture.ingest(userEvent(projectID, binding.bindingKey, "s", "m1", initial), "auto-write");
    const replacement: MemoryCandidateV1 = {
      ...initial,
      summary: "Düzeltme: derleyici olarak TypeScript kullan.",
      content: "Düzeltme: derleyici olarak TypeScript kullan.",
      intent: "supersede",
      targetNoteID: created.noteID,
      confidence: 0.98,
    };
    const result = capture.ingest(userEvent(projectID, binding.bindingKey, "s", "m2", replacement), "auto-write");
    expect(result.outcome).toBe("materialized");
    expect(
      opened.db
        .query("SELECT id, status, supersedes_id FROM notes ORDER BY created_at, id")
        .all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.noteID, status: "superseded" }),
        expect.objectContaining({ id: result.noteID, status: "active", supersedes_id: created.noteID }),
      ]),
    );
    expect(
      opened.db.query("SELECT predicate FROM note_edges WHERE source_id = ?").get(result.noteID!) as {
        predicate: string;
      },
    ).toEqual({ predicate: "SUPERSEDES" });
    const final = capture.ingest(
      userEvent(projectID, binding.bindingKey, "s", "m3", {
        ...replacement,
        summary: "Düzeltme: derleyici olarak Rust kullan.",
        content: "Düzeltme: derleyici olarak Rust kullan.",
        targetNoteID: result.noteID,
      }),
      "auto-write",
    );
    expect(final.outcome).toBe("materialized");
    expect(memory.deleteProject(projectID, "Supersede").ok).toBe(true);
    expect((opened.db.query("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count).toBe(0);
    opened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("drains terminal retention backlog while preserving fresh and pending records", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-retention-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    const memory = new MemoryStore(opened.db);
    const projectID = memory.createProject("Retention").project!.projectID;
    const capture = new CaptureStore(opened.db);
    const binding = capture.bindProject({
      memoryProjectID: projectID,
      opencodeProjectID: "oc-project",
      canonicalDirectory: "/canonical/project",
    });
    capture.checkpoint("closed-session", binding.bindingKey, projectID);
    capture.markReconciled("closed-session", "closed");
    capture.checkpoint("active-session", binding.bindingKey, projectID);

    const candidate = extractExplicitUserCandidate("Kararım: saklama süresini uygula.")!;
    const states = [
      "materialized",
      "duplicate",
      "ignored",
      "rejected",
      "shadowed",
      "review",
      "failed",
      "dead",
    ] as const;
    const now = Date.now();
    for (let index = 0; index < 108; index++) {
      const event = userEvent(projectID, binding.bindingKey, "session-1", `message-${index}`, candidate);
      capture.ingest(event, "shadow");
      opened.db
        .query("UPDATE capture_events SET state = ?, processed_at = ?, updated_at = ? WHERE idempotency_key = ?")
        .run(
          states[index % states.length]!,
          now - 31 * 24 * 60 * 60_000,
          now - 31 * 24 * 60 * 60_000,
          event.idempotencyKey,
        );
    }
    const fresh = userEvent(projectID, binding.bindingKey, "session-1", "fresh", candidate);
    capture.ingest(fresh, "shadow");
    const pending = userEvent(projectID, binding.bindingKey, "session-1", "pending", candidate);
    capture.ingest(pending, "shadow");
    opened.db
      .query("UPDATE capture_events SET state = 'pending', processed_at = NULL WHERE idempotency_key = ?")
      .run(pending.idempotencyKey);

    const oldRisky = userEvent(projectID, binding.bindingKey, "session-1", "old-quarantine", {
      ...candidate,
      content: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    });
    capture.ingest(oldRisky, "shadow");
    opened.db
      .query("UPDATE capture_events SET processed_at = ?, updated_at = ? WHERE idempotency_key = ?")
      .run(now - 8 * 24 * 60 * 60_000, now - 8 * 24 * 60 * 60_000, oldRisky.idempotencyKey);
    const youngRisky = userEvent(projectID, binding.bindingKey, "session-1", "young-quarantine", {
      ...candidate,
      content: "-----BEGIN PRIVATE KEY-----\nyoung\n-----END PRIVATE KEY-----",
    });
    capture.ingest(youngRisky, "shadow");
    opened.db
      .query("UPDATE capture_checkpoints SET updated_at = ? WHERE session_id = 'closed-session'")
      .run(now - 31 * 24 * 60 * 60_000);

    expect(capture.runRetentionBacklog(now)).toEqual({ summarized: 108, deleted: 1, checkpoints: 1 });
    expect(
      (opened.db.query("SELECT COUNT(*) AS count FROM capture_events WHERE payload_json IS NOT NULL").get() as {
        count: number;
      }).count,
    ).toBe(2);
    expect(
      (opened.db.query("SELECT state FROM capture_events WHERE idempotency_key = ?").get(youngRisky.idempotencyKey) as {
        state: string;
      }).state,
    ).toBe("quarantined");
    expect(capture.getCheckpoint("closed-session")).toBeUndefined();
    expect(capture.getCheckpoint("active-session")?.state).toBe("active");
    opened.close();
    rmSync(directory, { recursive: true, force: true });
  }, 20_000);
});

function userEvent(
  projectID: string,
  bindingKey: string,
  sessionID: string,
  messageID: string,
  candidate: MemoryCandidateV1,
): CaptureEventV1 {
  return {
    schema: CAPTURE_SCHEMA,
    idempotencyKey: captureIdempotencyKey({ kind: "user", bindingKey, sessionID, messageID }),
    projectID,
    bindingKey,
    kind: "user-candidate",
    source: {
      system: "opencode-v2",
      opencodeVersion: "0.0.0-beta-18743",
      pluginVersion: PRODUCT_VERSION,
      sessionID,
      messageID,
      observedAt: Date.now(),
    },
    candidate,
    redaction: { policyVersion: "redaction/1", replacements: 0, truncated: false },
  };
}
