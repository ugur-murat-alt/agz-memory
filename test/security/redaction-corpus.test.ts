import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CAPTURE_SCHEMA, SUPPORTED_OPENCODE_VERSION, type CaptureEventV1 } from "../../src/capture/contract";
import { captureIdempotencyKey } from "../../src/capture/identity";
import { redactText } from "../../src/capture/redact";
import { openMemoryDatabase } from "../../src/db";
import { MemoryStore } from "../../src/store";
import { CaptureStore } from "../../src/store/capture";

const PRIVATE_KEY_BODY = "MII" + "A".repeat(32);
const URI_PASSWORD = "uri-password-" + "a".repeat(16);
const BEARER_TOKEN = "a".repeat(32);
const BASIC_TOKEN = "QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
const GITHUB_TOKEN = `ghp_${"a".repeat(36)}`;
const GITHUB_PAT = `github_pat_${"a".repeat(36)}`;
const GITLAB_TOKEN = `glpat-${"a".repeat(24)}`;
const AWS_ACCESS_KEY = `AKIA${"A".repeat(16)}`;
const AWS_SECRET_KEY = "aws-secret-" + "a".repeat(32);
const JWT = `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`;
const ASSIGNED_SECRET = "assignment-secret-" + "a".repeat(16);
const OPENAI_TOKEN = "sk-proj-" + "a".repeat(48);
const ANTHROPIC_TOKEN = "sk-ant-api03-" + "a".repeat(40);
const GOOGLE_API_KEY = "AIza" + "a".repeat(35);
const SLACK_TOKEN = `xoxb-${"a".repeat(12)}-${"a".repeat(12)}-${"a".repeat(24)}`;
const STRIPE_TOKEN = "sk_live_" + "a".repeat(40);
const NPM_TOKEN = "npm_" + "a".repeat(36);

const SECRET_CORPUS = [
  {
    name: "generic private key block",
    input: privateKey("PRIVATE KEY"),
    canary: PRIVATE_KEY_BODY,
  },
  {
    name: "RSA private key block",
    input: privateKey("RSA PRIVATE KEY"),
    canary: PRIVATE_KEY_BODY,
  },
  {
    name: "EC private key block",
    input: privateKey("EC PRIVATE KEY"),
    canary: PRIVATE_KEY_BODY,
  },
  {
    name: "OpenSSH private key block",
    input: privateKey("OPENSSH PRIVATE KEY"),
    canary: PRIVATE_KEY_BODY,
  },
  {
    name: "DSA private key block",
    input: privateKey("DSA PRIVATE KEY"),
    canary: PRIVATE_KEY_BODY,
  },
  {
    name: "encrypted private key block",
    input: privateKey("ENCRYPTED PRIVATE KEY"),
    canary: PRIVATE_KEY_BODY,
  },
  {
    name: "PGP private key block",
    input: privateKey("PGP PRIVATE KEY BLOCK"),
    canary: PRIVATE_KEY_BODY,
  },
  {
    name: "credential URI",
    input: `postgres://capture_user:${URI_PASSWORD}@db.example.test/memory`,
    canary: URI_PASSWORD,
  },
  {
    name: "bearer token",
    input: `Authorization: Bearer ${BEARER_TOKEN}`,
    canary: BEARER_TOKEN,
  },
  {
    name: "basic authorization",
    input: `Authorization: Basic ${BASIC_TOKEN}`,
    canary: BASIC_TOKEN,
  },
  {
    name: "GitHub classic token",
    input: GITHUB_TOKEN,
    canary: GITHUB_TOKEN,
  },
  {
    name: "GitHub fine-grained token",
    input: GITHUB_PAT,
    canary: GITHUB_PAT,
  },
  {
    name: "GitLab token",
    input: GITLAB_TOKEN,
    canary: GITLAB_TOKEN,
  },
  {
    name: "AWS access key",
    input: `AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY}`,
    canary: AWS_ACCESS_KEY,
  },
  {
    name: "AWS secret access key",
    input: `AWS_SECRET_ACCESS_KEY=${AWS_SECRET_KEY}`,
    canary: AWS_SECRET_KEY,
  },
  {
    name: "JWT",
    input: `Authorization: ${JWT}`,
    canary: JWT,
  },
  {
    name: "password assignment",
    input: `PASSWORD=${ASSIGNED_SECRET}`,
    canary: ASSIGNED_SECRET,
  },
  {
    name: "punctuation-leading password assignment",
    input: "PASSWORD=!Secret123",
    canary: "!Secret123",
  },
  {
    name: "punctuation-only password assignment",
    input: "PASSWORD=!@#%^&*()_+",
    canary: "!@#%^&*()_+",
  },
  {
    name: "token assignment",
    input: `TOKEN=${ASSIGNED_SECRET}`,
    canary: ASSIGNED_SECRET,
  },
  {
    name: "API key assignment",
    input: `API_KEY="${ASSIGNED_SECRET}"`,
    canary: ASSIGNED_SECRET,
  },
  {
    name: "OpenAI-style token",
    input: `OPENAI_API_KEY=${OPENAI_TOKEN}`,
    canary: OPENAI_TOKEN,
  },
  {
    name: "Anthropic-style token",
    input: `ANTHROPIC_API_KEY=${ANTHROPIC_TOKEN}`,
    canary: ANTHROPIC_TOKEN,
  },
  {
    name: "Google API key",
    input: `GOOGLE_API_KEY=${GOOGLE_API_KEY}`,
    canary: GOOGLE_API_KEY,
  },
  {
    name: "Slack bot token",
    input: `SLACK_TOKEN=${SLACK_TOKEN}`,
    canary: SLACK_TOKEN,
  },
  {
    name: "Stripe secret key",
    input: `STRIPE_SECRET_KEY=${STRIPE_TOKEN}`,
    canary: STRIPE_TOKEN,
  },
  {
    name: "npm access token",
    input: `NPM_TOKEN=${NPM_TOKEN}`,
    canary: NPM_TOKEN,
  },
] as const;

const FALSE_POSITIVE_CORPUS = [
  "Documentation names PASSWORD, PASSWD, SECRET, TOKEN, API_KEY, and PRIVATE_KEY without values.",
  "Authorization: Bearer <token> and Authorization: Basic <credentials> are placeholders.",
  "The URL https://example.test/path contains no user information or password.",
  "The prefixes ghp_, glpat-, AKIA, sk-proj-, and xoxb- are shown without credentials.",
  "-----BEGIN PRIVATE KEY----- is an incomplete documentation marker.",
  "A normal sentence can contain the words secret and token without being a secret.",
] as const;

describe("AGZ-018 redaction corpus", () => {
  for (const secret of SECRET_CORPUS) {
    test(`redacts and quarantines ${secret.name}`, () => {
      const result = redactText(secret.input, { maxCharacters: 4_800 });
      expect(result.text).not.toContain(secret.canary);
      expect(result.replacements).toBeGreaterThan(0);
      expect(result.quarantined).toBe(true);
    });
  }

  for (const value of FALSE_POSITIVE_CORPUS) {
    test(`does not redact false positive: ${value.slice(0, 42)}`, () => {
      expect(redactText(value, { maxCharacters: 4_800 })).toEqual({
        text: value,
        replacements: 0,
        classes: {},
        truncated: false,
        quarantined: false,
      });
    });
  }

  test("handles the exact 4,800-character boundary without retaining a boundary secret", () => {
    const exact = "b".repeat(4_800);
    const over = exact + "x";
    expect(redactText(exact, { maxCharacters: 4_800 })).toMatchObject({
      text: exact,
      truncated: false,
    });
    expect(redactText(over, { maxCharacters: 4_800 })).toMatchObject({
      text: over.slice(0, 4_800),
      truncated: true,
    });

    const boundarySecret = `Bearer ${BEARER_TOKEN}`;
    const result = redactText("b".repeat(4_800) + boundarySecret, { maxCharacters: 4_800 });
    expect(result.text).not.toContain(BEARER_TOKEN);
    expect(result.quarantined).toBe(true);
  });

  test("fails closed before persistence and scans every SQLite table for raw canaries", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-redaction-corpus-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    try {
      const memory = new MemoryStore(opened.db);
      const projectID = memory.createProject("Redaction Corpus").project!.projectID;
      const capture = new CaptureStore(opened.db);
      const binding = capture.bindProject({
        memoryProjectID: projectID,
        opencodeProjectID: "opencode-redaction-corpus",
        canonicalDirectory: "/redaction-corpus",
      });
      const event = secretEvent(projectID, binding.bindingKey, OPENAI_TOKEN, "openai");
      const punctuation = "!@#%^&*()_+";
      const punctuationEvent = secretEvent(projectID, binding.bindingKey, punctuation, "punctuation");

      expect(capture.ingest(event, "auto-write").outcome).toBe("quarantined");
      expect(capture.ingest(punctuationEvent, "auto-write").outcome).toBe("quarantined");
      expect(scanSQLiteForCanaries(opened.db, [OPENAI_TOKEN, punctuation])).toEqual([]);
    } finally {
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function privateKey(label: string): string {
  return `-----BEGIN ${label}-----\n${PRIVATE_KEY_BODY}\n-----END ${label}-----`;
}

function secretEvent(
  projectID: string,
  bindingKey: string,
  canary: string,
  suffix: string,
): CaptureEventV1 {
  const messageID = `redaction-message-${suffix}`;
  return {
    schema: CAPTURE_SCHEMA,
    idempotencyKey: captureIdempotencyKey({
      kind: "user",
      bindingKey,
      sessionID: "redaction-session",
      messageID,
    }),
    projectID,
    bindingKey,
    kind: "user-candidate",
    source: {
      system: "opencode-v2",
      opencodeVersion: SUPPORTED_OPENCODE_VERSION,
      pluginVersion: "0.5.0-test",
      sessionID: "redaction-session",
      messageID,
      observedAt: 1,
    },
    candidate: {
      kind: "decision",
      title: "Secret canary",
      summary: "This capture must never persist its raw canary.",
      content: `Karar: PASSWORD=${canary}`,
      intent: "create",
      confidence: 0.99,
      evidence: "explicit-user",
    },
    redaction: { policyVersion: "redaction/1", replacements: 0, truncated: false },
  };
}

function scanSQLiteForCanaries(db: Database, canaries: readonly string[]): string[] {
  const tables = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  const hits: string[] = [];
  for (const table of tables) {
    const rows = db.query(`SELECT * FROM ${quoteIdentifier(table.name)}`).all() as Array<Record<string, unknown>>;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const serialized = JSON.stringify(rows[rowIndex]);
      for (const canary of canaries) {
        if (serialized.includes(canary)) hits.push(`${table.name}[${rowIndex}]`);
      }
    }
  }
  return hits;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
