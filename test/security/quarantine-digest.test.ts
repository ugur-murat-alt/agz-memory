import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { QuarantineKeyring } from "../../src/security/quarantine-key";

const source = {
  schema: "agz-memory.capture/2",
  projectID: "c377cbb1-9a9b-4f51-a9c4-a9f5af45c081",
  bindingKey: "a".repeat(64),
  kind: "user-candidate" as const,
  source: {
    system: "opencode-v2" as const,
    opencodeVersion: "0.0.0-beta-18743",
    pluginVersion: "0.5.0",
    sessionID: "session-canary",
    messageID: "message-canary",
  },
};

describe("quarantine keyed source digests", () => {
  const keyringTest = process.platform === "win32" ? test.skip : test;
  const windowsTest = process.platform === "win32" ? test : test.skip;

  windowsTest("fails closed when Windows ACL verification is unavailable", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-quarantine-windows-"));
    try {
      expect(() => new QuarantineKeyring(join(directory, "keyring.json")).ensureActiveKey())
        .toThrow("quarantine_keyring_platform_unsupported");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  keyringTest("is deterministic for one source/key, rotates without losing verification, and never hashes payload text", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-quarantine-key-"));
    const keyPath = join(directory, "quarantine.keys");
    try {
      const keyring = new QuarantineKeyring(keyPath);
      const payloadFingerprint = "a".repeat(64);
      const changedPayloadFingerprint = "b".repeat(64);
      const first = keyring.digestSource(source, payloadFingerprint);
      expect(keyring.digestSource(source, payloadFingerprint)).toEqual(first);
      expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(first.digest).not.toBe(payloadFingerprint);
      expect(keyring.digestSource(source, changedPayloadFingerprint).digest).not.toBe(first.digest);
      expect(lstatSync(keyPath).mode & 0o777).toBe(0o600);

      const rotated = keyring.rotate();
      const second = keyring.digestSource(source, payloadFingerprint);
      expect(second.keyID).toBe(rotated.keyID);
      expect(second.digest).not.toBe(first.digest);
      expect(keyring.verifySourceDigest(source, payloadFingerprint, first.keyID, first.digest)).toBe(true);
      expect(keyring.verifySourceDigest(source, payloadFingerprint, second.keyID, second.digest)).toBe(true);
      expect(keyring.verifySourceDigest(source, changedPayloadFingerprint, first.keyID, first.digest)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  keyringTest("rejects missing, weak, and symlinked keyrings without exposing key material", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-quarantine-key-"));
    const keyPath = join(directory, "quarantine.keys");
    try {
      const keyring = new QuarantineKeyring(keyPath);
      expect(() => keyring.readActiveKey()).toThrow("quarantine_keyring_missing");

      keyring.ensureActiveKey();
      chmodSync(keyPath, 0o644);
      expect(() => keyring.readActiveKey()).toThrow("quarantine_keyring_permissions");

      chmodSync(keyPath, 0o600);
      const linkPath = join(directory, "quarantine-link.keys");
      symlinkSync(keyPath, linkPath);
      expect(() => new QuarantineKeyring(linkPath).readActiveKey()).toThrow("quarantine_keyring_symlink");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  keyringTest("handles concurrent create and rotation without a partial or split active key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-quarantine-key-"));
    const keyPath = join(directory, "quarantine.keys");
    try {
      const worker = `import { QuarantineKeyring } from ${JSON.stringify(
        join(process.cwd(), "src/security/quarantine-key.ts"),
      )}; const ring = new QuarantineKeyring(process.argv[1]); ring.ensureActiveKey(); if (process.argv[2] === "rotate") ring.rotate();`;
      const processes = Array.from({ length: 6 }, (_, index) =>
        Bun.spawn({ cmd: [process.execPath, "--eval", worker, keyPath, index % 2 ? "rotate" : "create"] }),
      );
      expect(await Promise.all(processes.map((child) => child.exited))).toEqual(Array(6).fill(0));
      const keyring = new QuarantineKeyring(keyPath);
      expect(keyring.readActiveKey().keyID).toMatch(/^[0-9a-f]{24}$/);
      expect(keyring.digestSource(source, "c".repeat(64)).digest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
