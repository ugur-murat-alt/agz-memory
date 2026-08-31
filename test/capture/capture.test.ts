import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openMemoryDatabase } from "../../src/db";
import { MemoryStore } from "../../src/store";
import { CaptureStore } from "../../src/store/capture";
import { captureIdempotencyKey } from "../../src/capture/identity";
import { extractExplicitUserCandidate } from "../../src/capture/policy";
import { projectAssistantParts } from "../../src/capture/projection";
import { redactText } from "../../src/capture/redact";
import { parseCaptureEvent, type CaptureEventV1, type MemoryCandidateV1 } from "../../src/capture/contract";

describe("capture safety core", () => {
  test("uses stable native identity hashes and strict bounded events", () => {
    expect(
      captureIdempotencyKey({
        kind: "user",
        bindingKey: "binding",
        sessionID: "session",
        messageID: "message",
      }),
    ).toBe("644b3fe62359965afe2ee3f5a51db0bbfb7f91c5516c420d10de5e83d16c44f6");
    expect(
      captureIdempotencyKey({
        kind: "assistant",
        bindingKey: "binding",
        sessionID: "session",
        assistantMessageID: "assistant",
        ordinal: 7,
      }),
    ).toBe("e3d04a2df736361209875663e929bfadb2865738b200d223c67b849b04b265d3");
    expect(
      captureIdempotencyKey({
        kind: "tool",
        bindingKey: "binding",
        sessionID: "session",
        assistantMessageID: "assistant",
        toolCallID: "call",
        terminalStatus: "completed",
      }),
    ).toBe("be3da97da64d72a64f4989f9b20256834fee8dfa6f882012bd0697eac47aba76");
    expect(
      captureIdempotencyKey({
        kind: "summary",
        bindingKey: "binding",
        sessionID: "session",
        checkpointMessageID: "checkpoint",
      }),
    ).toBe("d9cca69e3104563c3d0598a7dbb22945b2f51ba30cc5a44c6d5851d32d7b440c");
    expect(() => parseCaptureEvent({ schema: "opencode2-memory.capture/1" })).toThrow();
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
    const directory = mkdtempSync(join(tmpdir(), "opencode2-memory-capture-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    const memory = new MemoryStore(opened.db, ["fake@1"]);
    const projectID = memory.createProject("Capture").project!.projectID;
    const capture = new CaptureStore(opened.db, ["fake@1"]);
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
    const stored = opened.db
      .query("SELECT payload_json FROM capture_events WHERE idempotency_key = ?")
      .get(risky.idempotencyKey) as { payload_json: string | null };
    expect(stored.payload_json).toBeNull();
    expect(JSON.stringify(opened.db.query("SELECT * FROM capture_events").all())).not.toContain("abc123");
    opened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("atomically supersedes only an explicit matching target", () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode2-memory-supersede-"));
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
    opened.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

function userEvent(
  projectID: string,
  bindingKey: string,
  sessionID: string,
  messageID: string,
  candidate: MemoryCandidateV1,
): CaptureEventV1 {
  return {
    schema: "opencode2-memory.capture/1",
    idempotencyKey: captureIdempotencyKey({ kind: "user", bindingKey, sessionID, messageID }),
    projectID,
    bindingKey,
    kind: "user-candidate",
    source: {
      system: "opencode-v2",
      opencodeVersion: "0.0.0-beta-18743",
      pluginVersion: "0.4.0-beta.1",
      sessionID,
      messageID,
      observedAt: Date.now(),
    },
    candidate,
    redaction: { policyVersion: "redaction/1", replacements: 0, truncated: false },
  };
}
