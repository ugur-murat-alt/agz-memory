import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CAPTURE_SCHEMA,
  parseCaptureEvent,
  SUPPORTED_OPENCODE_VERSION,
  type CaptureEventV1,
} from "../../src/capture/contract";
import { captureIdempotencyKey } from "../../src/capture/identity";
import { noteContentHash } from "../../src/hash";
import { openMemoryDatabase } from "../../src/db";
import { MemoryStore } from "../../src/store";
import { CaptureStore } from "../../src/store/capture";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const BINDING_KEY = "b".repeat(64);

describe("capture contract v2 hardening", () => {
  test("uses the schema 11 capture contract", () => {
    expect(CAPTURE_SCHEMA as string).toBe("agz-memory.capture/2");
  });

  test("AGZ-006 separates capture identity tuples that collide on NUL delimiters", () => {
    const pairs = [
      [
        {
          kind: "user",
          bindingKey: "binding",
          sessionID: "session\0message",
          messageID: "tail",
        },
        {
          kind: "user",
          bindingKey: "binding",
          sessionID: "session",
          messageID: "message\0tail",
        },
      ],
      [
        {
          kind: "assistant",
          bindingKey: "binding\0session",
          sessionID: "id",
          assistantMessageID: "assistant",
          ordinal: 0,
        },
        {
          kind: "assistant",
          bindingKey: "binding",
          sessionID: "session\0id",
          assistantMessageID: "assistant",
          ordinal: 0,
        },
      ],
      [
        {
          kind: "tool",
          bindingKey: "binding",
          sessionID: "session",
          assistantMessageID: "assistant\0call",
          toolCallID: "tail",
          terminalStatus: "completed",
        },
        {
          kind: "tool",
          bindingKey: "binding",
          sessionID: "session",
          assistantMessageID: "assistant",
          toolCallID: "call\0tail",
          terminalStatus: "completed",
        },
      ],
      [
        {
          kind: "summary",
          bindingKey: "binding\0session",
          sessionID: "id",
          checkpointMessageID: "checkpoint",
        },
        {
          kind: "summary",
          bindingKey: "binding",
          sessionID: "session\0id",
          checkpointMessageID: "checkpoint",
        },
      ],
    ] as const;

    for (const [left, right] of pairs) {
      expect(captureIdempotencyKey(left)).not.toBe(
        captureIdempotencyKey(right),
      );
    }
  });

  test("AGZ-006 separates note content tuples that collide on NUL delimiters", () => {
    expect(
      noteContentHash("fact", "title\0summary", "content", "tail"),
    ).not.toBe(noteContentHash("fact", "title", "summary\0content", "tail"));
  });

  test("AGZ-006 rejects ill-formed Unicode instead of collapsing hash identities", () => {
    expect(() => noteContentHash("fact", "\ud800", "summary", "content")).toThrow(
      /well-formed Unicode/,
    );
    expect(() =>
      captureIdempotencyKey({
        kind: "user",
        bindingKey: "binding",
        sessionID: "\udfff",
        messageID: "message",
      }),
    ).toThrow(/well-formed Unicode/);
    expect(() => noteContentHash("fact", "\ufffd", "summary", "content")).not.toThrow();
  });

  test("AGZ-006 separates binding tuples that collide on NUL delimiters", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-capture-hash-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    try {
      const memory = new MemoryStore(opened.db);
      const projectA = memory.createProject("Hash A").project!.projectID;
      const projectB = memory.createProject("Hash B").project!.projectID;
      const capture = new CaptureStore(opened.db);
      const first = capture.bindProject({
        memoryProjectID: projectA,
        opencodeProjectID: "oc\0project",
        workspaceID: "workspace",
        canonicalDirectory: "/hash-collision",
      });
      const second = capture.bindProject({
        memoryProjectID: projectB,
        opencodeProjectID: "oc",
        workspaceID: "project\0workspace",
        canonicalDirectory: "/hash-collision",
      });
      expect(first.bindingKey).not.toBe(second.bindingKey);
    } finally {
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("AGZ-007 rejects a reused idempotency key with different source or payload", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "agz-memory-capture-conflict-"),
    );
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    try {
      const memory = new MemoryStore(opened.db);
      const projectID =
        memory.createProject("Capture Conflict").project!.projectID;
      const capture = new CaptureStore(opened.db);
      const binding = capture.bindProject({
        memoryProjectID: projectID,
        opencodeProjectID: "oc-conflict",
        canonicalDirectory: "/capture-conflict",
      });
      const first = captureEvent(
        projectID,
        binding.bindingKey,
        "first payload",
        1,
      );
      const sourceConflict = {
        ...structuredClone(first),
        source: { ...first.source, pluginVersion: "different-version" },
      } as CaptureEventV1;
      const retriedObservation = {
        ...structuredClone(first),
        source: { ...first.source, observedAt: 2 },
      } as CaptureEventV1;
      const payloadConflict = {
        ...structuredClone(first),
        candidate: { ...first.candidate!, content: "second payload" },
      } as CaptureEventV1;

      expect(capture.ingest(first, "shadow").outcome).toBe("shadowed");
      expect(capture.ingest(retriedObservation, "shadow")).toMatchObject({
        outcome: "duplicate",
        existing: true,
      });
      expect(() => capture.ingest(sourceConflict, "shadow")).toThrow(
        "idempotency_conflict",
      );
      expect(() => capture.ingest(payloadConflict, "shadow")).toThrow(
        "idempotency_conflict",
      );
      expect(
        (
          opened.db
            .query("SELECT COUNT(*) AS count FROM capture_events")
            .get() as { count: number }
        ).count,
      ).toBe(1);
      expect(
        (
          opened.db.query("SELECT payload_json FROM capture_events").get() as {
            payload_json: string;
          }
        ).payload_json,
      ).toContain("first payload");
    } finally {
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("AGZ-007 preserves a canonical payload fingerprint after retention", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-capture-retained-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    try {
      const memory = new MemoryStore(opened.db);
      const projectID = memory.createProject("Retained Capture").project!.projectID;
      const capture = new CaptureStore(opened.db);
      const binding = capture.bindProject({
        memoryProjectID: projectID,
        opencodeProjectID: "oc-retained",
        canonicalDirectory: "/capture-retained",
      });
      const first = captureEvent(projectID, binding.bindingKey, "retained payload", 1);

      expect(capture.ingest(first, "shadow").outcome).toBe("shadowed");
      opened.db
        .query("UPDATE capture_events SET processed_at = 1 WHERE idempotency_key = ?")
        .run(first.idempotencyKey);
      expect(capture.runRetention(31 * 24 * 60 * 60 * 1_000)).toMatchObject({ summarized: 1 });
      expect(
        opened.db
          .query("SELECT payload_json, length(payload_hash) AS hash_length FROM capture_events")
          .get(),
      ).toEqual({ payload_json: null, hash_length: 64 });

      const retry = {
        ...structuredClone(first),
        source: { ...first.source, observedAt: 2 },
      } as CaptureEventV1;
      const changed = {
        ...structuredClone(retry),
        candidate: { ...retry.candidate!, content: "changed retained payload" },
      } as CaptureEventV1;
      expect(capture.ingest(retry, "shadow")).toMatchObject({ outcome: "duplicate", existing: true });
      expect(() => capture.ingest(changed, "shadow")).toThrow("idempotency_conflict");
    } finally {
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("AGZ-007 fingerprints quarantined events without retaining their payload", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-capture-quarantine-id-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    try {
      const memory = new MemoryStore(opened.db);
      const projectID = memory.createProject("Quarantine Identity").project!.projectID;
      const capture = new CaptureStore(opened.db);
      const binding = capture.bindProject({
        memoryProjectID: projectID,
        opencodeProjectID: "oc-quarantine-id",
        canonicalDirectory: "/capture-quarantine-id",
      });
      const first = captureEvent(projectID, binding.bindingKey, "blocked-value alpha", 1);
      const options = { denylist: ["blocked-value"] };

      expect(capture.ingest(first, "auto-write", options).outcome).toBe("quarantined");
      expect(
        opened.db
          .query("SELECT payload_json, length(payload_hash) AS hash_length FROM capture_events")
          .get(),
      ).toEqual({ payload_json: null, hash_length: 64 });

      const retry = {
        ...structuredClone(first),
        source: { ...first.source, observedAt: 2 },
      } as CaptureEventV1;
      const changed = {
        ...structuredClone(retry),
        candidate: { ...retry.candidate!, content: "blocked-value beta" },
      } as CaptureEventV1;
      expect(capture.ingest(retry, "auto-write", options)).toMatchObject({
        outcome: "duplicate",
        existing: true,
      });
      expect(() => capture.ingest(changed, "auto-write", options)).toThrow(
        "idempotency_conflict",
      );
    } finally {
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("AGZ-019 enforces kind-specific source identity fields", () => {
    const validKinds: CaptureEventV1["kind"][] = [
      "user-candidate",
      "assistant-candidate",
      "session-summary",
      "tool-signal",
    ];
    for (const kind of validKinds) {
      expect(() => parseCaptureEvent(validEvent(kind))).not.toThrow();
    }

    const user = validEvent("user-candidate");
    expect(() => parseCaptureEvent(withSource(user, { ordinal: 0 }))).toThrow();
    expect(() =>
      parseCaptureEvent(withSource(user, { toolCallID: "tool-1" })),
    ).toThrow();

    const assistant = validEvent("assistant-candidate");
    expect(() =>
      parseCaptureEvent(withoutSource(assistant, "ordinal")),
    ).toThrow();
    expect(() =>
      parseCaptureEvent(withSource(assistant, { toolCallID: "tool-1" })),
    ).toThrow();

    const summary = validEvent("session-summary");
    expect(() =>
      parseCaptureEvent(withoutSource(summary, "messageID")),
    ).toThrow();
    expect(() =>
      parseCaptureEvent(withSource(summary, { ordinal: 0 })),
    ).toThrow();

    const tool = validEvent("tool-signal");
    expect(() => parseCaptureEvent(withoutSource(tool, "messageID"))).toThrow();
    expect(() =>
      parseCaptureEvent(withoutSource(tool, "toolCallID")),
    ).toThrow();
    expect(() => parseCaptureEvent(withSource(tool, { ordinal: 0 }))).toThrow();
  });

  test("AGZ-020 rejects cross-project binding, capture-event, and outbox foreign keys", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-capture-fk-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    try {
      const memory = new MemoryStore(opened.db);
      const projectA = memory.createProject("Foreign Key A").project!.projectID;
      const projectB = memory.createProject("Foreign Key B").project!.projectID;
      const noteA = memory.update(projectA, {
        kind: "fact",
        title: "A",
        summary: "A",
        content: "A",
      }).id!;
      const noteB = memory.update(projectB, {
        kind: "fact",
        title: "B",
        summary: "B",
        content: "B",
      }).id!;
      const capture = new CaptureStore(opened.db);
      const bindingA = capture.bindProject({
        memoryProjectID: projectA,
        opencodeProjectID: "oc-fk-a",
        canonicalDirectory: "/foreign-key-a",
      });
      const bindingB = capture.bindProject({
        memoryProjectID: projectB,
        opencodeProjectID: "oc-fk-b",
        canonicalDirectory: "/foreign-key-b",
      });

      expect(() =>
        opened.db
          .query(
            `INSERT INTO capture_checkpoints
              (session_id, binding_key, project_id, state, next_reconcile_at, created_at, updated_at)
             VALUES (?, ?, ?, 'active', ?, ?, ?)`,
          )
          .run(
            "cross-project-checkpoint",
            bindingB.bindingKey,
            projectA,
            1,
            1,
            1,
          ),
      ).toThrow(/foreign key/i);

      expect(() =>
        opened.db
          .query(
            `INSERT INTO capture_events
              (idempotency_key, contract, project_id, binding_key, event_kind,
               source_session_id, source_message_id, redaction_version, state, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'user-candidate', ?, ?, 'redaction/1', 'pending', ?, ?)`,
          )
          .run(
            "c".repeat(64),
            CAPTURE_SCHEMA,
            projectA,
            bindingB.bindingKey,
            "cross-project-event",
            "cross-project-message",
            1,
            1,
          ),
      ).toThrow(/foreign key/i);

      expect(() =>
        opened.db
          .query(
            `INSERT INTO index_outbox
              (backend, operation_key, operation, project_id, note_id, revision, content_hash,
               available_at, created_at)
             VALUES (?, ?, 'upsert-note', ?, ?, 1, ?, ?, ?)`,
          )
          .run("fake@1", "o".repeat(64), projectA, noteB, "d".repeat(64), 1, 1),
      ).toThrow(/foreign key/i);

      const event = captureEvent(projectA, bindingA.bindingKey, "tenant event", 1);
      expect(capture.ingest(event, "shadow").outcome).toBe("shadowed");
      expect(() =>
        opened.db
          .query("UPDATE capture_events SET note_id = ? WHERE idempotency_key = ?")
          .run(noteB, event.idempotencyKey),
      ).toThrow(/foreign key/i);

      expect(noteA).not.toBe(noteB);
      expect(bindingA.bindingKey).not.toBe(bindingB.bindingKey);
    } finally {
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("AGZ-023 permits one session ID in two distinct bindings", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "agz-memory-capture-session-binding-"),
    );
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    try {
      const memory = new MemoryStore(opened.db);
      const projectA =
        memory.createProject("Session Binding A").project!.projectID;
      const projectB =
        memory.createProject("Session Binding B").project!.projectID;
      const capture = new CaptureStore(opened.db);
      const bindingA = capture.bindProject({
        memoryProjectID: projectA,
        opencodeProjectID: "oc-session-a",
        canonicalDirectory: "/session-binding-a",
      });
      const bindingB = capture.bindProject({
        memoryProjectID: projectB,
        opencodeProjectID: "oc-session-b",
        canonicalDirectory: "/session-binding-b",
      });

      expect(() =>
        capture.checkpoint("shared-session", bindingA.bindingKey, projectA),
      ).not.toThrow();
      expect(() =>
        capture.checkpoint("shared-session", bindingB.bindingKey, projectB),
      ).not.toThrow();
      expect(
        opened.db
          .query(
            "SELECT session_id, binding_key, project_id FROM capture_checkpoints WHERE session_id = ? ORDER BY project_id",
          )
          .all("shared-session"),
      ).toEqual(
        [
          {
            session_id: "shared-session",
            binding_key: bindingA.bindingKey,
            project_id: projectA,
          },
          {
            session_id: "shared-session",
            binding_key: bindingB.bindingKey,
            project_id: projectB,
          },
        ].sort((left, right) =>
          left.project_id.localeCompare(right.project_id),
        ),
      );
    } finally {
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function validEvent(kind: CaptureEventV1["kind"]): CaptureEventV1 {
  const common = {
    schema: CAPTURE_SCHEMA,
    projectID: PROJECT_A,
    bindingKey: BINDING_KEY,
    redaction: {
      policyVersion: "redaction/1",
      replacements: 0,
      truncated: false,
    },
  };
  if (kind === "user-candidate") {
    return {
      ...common,
      kind,
      idempotencyKey: captureIdempotencyKey({
        kind: "user",
        bindingKey: BINDING_KEY,
        sessionID: "session-1",
        messageID: "message-1",
      }),
      source: source({ sessionID: "session-1", messageID: "message-1" }),
      candidate: candidate("explicit-user"),
    };
  }
  if (kind === "assistant-candidate") {
    return {
      ...common,
      kind,
      idempotencyKey: captureIdempotencyKey({
        kind: "assistant",
        bindingKey: BINDING_KEY,
        sessionID: "session-1",
        assistantMessageID: "assistant-1",
        ordinal: 0,
      }),
      source: source({
        sessionID: "session-1",
        messageID: "assistant-1",
        ordinal: 0,
      }),
      candidate: candidate("verified-outcome"),
    };
  }
  if (kind === "session-summary") {
    return {
      ...common,
      kind,
      idempotencyKey: captureIdempotencyKey({
        kind: "summary",
        bindingKey: BINDING_KEY,
        sessionID: "session-1",
        checkpointMessageID: "checkpoint-1",
      }),
      source: source({ sessionID: "session-1", messageID: "checkpoint-1" }),
      candidate: candidate("session-summary"),
    };
  }
  return {
    ...common,
    kind,
    idempotencyKey: captureIdempotencyKey({
      kind: "tool",
      bindingKey: BINDING_KEY,
      sessionID: "session-1",
      assistantMessageID: "assistant-1",
      toolCallID: "tool-1",
      terminalStatus: "completed",
    }),
    source: source({
      sessionID: "session-1",
      messageID: "assistant-1",
      toolCallID: "tool-1",
    }),
    signal: { tool: "shell", status: "completed" },
  };
}

function source(fields: {
  sessionID: string;
  messageID?: string;
  ordinal?: number;
  toolCallID?: string;
}): CaptureEventV1["source"] {
  return {
    system: "opencode-v2",
    opencodeVersion: SUPPORTED_OPENCODE_VERSION,
    pluginVersion: "0.5.0-test",
    observedAt: 1,
    ...fields,
  };
}

function candidate(
  evidence: "explicit-user" | "verified-outcome" | "session-summary",
) {
  return {
    kind: "fact" as const,
    title: "A valid capture candidate",
    summary: "A valid capture candidate",
    content: "A valid capture candidate",
    intent: "create" as const,
    confidence: 0.99,
    evidence,
  };
}

function withSource(
  event: CaptureEventV1,
  fields: Record<string, unknown>,
): unknown {
  return { ...structuredClone(event), source: { ...event.source, ...fields } };
}

function withoutSource(event: CaptureEventV1, field: string): unknown {
  const copy = structuredClone(event) as CaptureEventV1;
  delete (copy.source as Record<string, unknown>)[field];
  return copy;
}

function captureEvent(
  projectID: string,
  bindingKey: string,
  content: string,
  observedAt: number,
): CaptureEventV1 {
  return {
    schema: CAPTURE_SCHEMA,
    idempotencyKey: captureIdempotencyKey({
      kind: "user",
      bindingKey,
      sessionID: "conflict-session",
      messageID: "conflict-message",
    }),
    projectID,
    bindingKey,
    kind: "user-candidate",
    source: {
      system: "opencode-v2",
      opencodeVersion: SUPPORTED_OPENCODE_VERSION,
      pluginVersion: "0.5.0-test",
      sessionID: "conflict-session",
      messageID: "conflict-message",
      observedAt,
    },
    candidate: {
      kind: "decision",
      title: "Conflict candidate",
      summary: content,
      content,
      intent: "create",
      confidence: 0.99,
      evidence: "explicit-user",
    },
    redaction: {
      policyVersion: "redaction/1",
      replacements: 0,
      truncated: false,
    },
  };
}
