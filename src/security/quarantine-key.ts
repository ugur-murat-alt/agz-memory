import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "fs";
import { dirname } from "path";

const KEYRING_FORMAT = "agz-memory.quarantine-keyring/1";
const KEY_BYTES = 32;
const KEY_ID_BYTES = 12;
const MAX_KEYRING_BYTES = 64 * 1024;
const KEY_MODE = 0o600;
const LOCK_TIMEOUT_MS = 1_000;
const RETRIES = 20;

export interface QuarantineSourceIdentity {
  schema: string;
  projectID: string;
  bindingKey: string;
  kind: string;
  source: {
    system: string;
    opencodeVersion: string;
    pluginVersion: string;
    sessionID: string;
    messageID?: string;
    ordinal?: number;
    toolCallID?: string;
  };
}

export interface QuarantineDigest {
  keyID: string;
  digest: string;
}

export interface QuarantineKeyReference {
  keyID: string;
}

interface KeyringDocument {
  format: typeof KEYRING_FORMAT;
  activeKeyID: string;
  keys: Record<string, string>;
}

interface ActiveKey extends QuarantineKeyReference {
  key: Buffer;
}

/**
 * Private local keyring for source-only quarantine digests. Windows is deliberately
 * fail-closed until a current-user ACL verifier is available.
 */
export class QuarantineKeyring {
  constructor(private readonly path: string) {}

  readActiveKey(): QuarantineKeyReference {
    return this.keyReference(this.readDocument());
  }

  ensureActiveKey(): QuarantineKeyReference {
    let lastError: unknown;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        return this.readActiveKey();
      } catch (error) {
        lastError = error;
        if (!isKeyringError(error, "quarantine_keyring_missing")) {
          if (attempt + 1 < RETRIES) {
            pause();
            continue;
          }
          throw error;
        }
      }

      try {
        this.createInitialKeyring();
      } catch (error) {
        lastError = error;
        if (!isKeyringError(error, "quarantine_keyring_exists")) throw error;
      }
      pause();
    }
    throw lastError instanceof Error ? lastError : new Error("quarantine_keyring_unavailable");
  }

  rotate(): QuarantineKeyReference {
    this.assertSupportedPlatform();
    const lockPath = `${this.path}.lock`;
    const lock = this.acquireLock(lockPath);
    try {
      const document = this.readDocument();
      const keyID = randomBytes(KEY_ID_BYTES).toString("hex");
      document.keys[keyID] = randomBytes(KEY_BYTES).toString("base64");
      document.activeKeyID = keyID;
      this.writeAtomically(document);
      return { keyID };
    } finally {
      closeSync(lock);
      rmSync(lockPath, { force: true });
    }
  }

  digestSource(
    source: QuarantineSourceIdentity,
    payloadFingerprint: string,
  ): QuarantineDigest {
    const active = this.activeKey(true);
    return digestSourceWithKey(source, payloadFingerprint, active);
  }

  /** Use after lifecycle initialization; a later missing key must fail closed. */
  digestExistingSource(
    source: QuarantineSourceIdentity,
    payloadFingerprint: string,
  ): QuarantineDigest {
    const active = this.activeKey(false);
    return digestSourceWithKey(source, payloadFingerprint, active);
  }

  verifySourceDigest(
    source: QuarantineSourceIdentity,
    payloadFingerprint: string,
    keyID: string,
    digest: string,
  ): boolean {
    if (
      !isPayloadFingerprint(payloadFingerprint) ||
      !/^[0-9a-f]{24}$/.test(keyID) ||
      !/^[0-9a-f]{64}$/.test(digest)
    ) {
      return false;
    }
    const document = this.readDocument();
    const encoded = document.keys[keyID];
    if (!encoded) return false;
    const expected = createHmac("sha256", Buffer.from(encoded, "base64"))
      .update(sourceDigestBytes(source, payloadFingerprint))
      .digest();
    return timingSafeEqual(expected, Buffer.from(digest, "hex"));
  }

  private activeKey(createIfMissing: boolean): ActiveKey {
    if (createIfMissing) this.ensureActiveKey();
    const document = this.readDocument();
    const keyID = document.activeKeyID;
    const encoded = document.keys[keyID];
    if (!encoded) throw new Error("quarantine_keyring_invalid");
    return { keyID, key: Buffer.from(encoded, "base64") };
  }

  private keyReference(document: KeyringDocument): QuarantineKeyReference {
    if (!document.keys[document.activeKeyID]) throw new Error("quarantine_keyring_invalid");
    return { keyID: document.activeKeyID };
  }

  private createInitialKeyring(): void {
    this.assertSupportedPlatform();
    this.assertSafeParent();
    const keyID = randomBytes(KEY_ID_BYTES).toString("hex");
    const document: KeyringDocument = {
      format: KEYRING_FORMAT,
      activeKeyID: keyID,
      keys: { [keyID]: randomBytes(KEY_BYTES).toString("base64") },
    };
    let fd: number | undefined;
    try {
      fd = openSync(
        this.path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        KEY_MODE,
      );
      fchmodSync(fd, KEY_MODE);
      writeSync(fd, JSON.stringify(document));
      fsyncSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("quarantine_keyring_exists");
      }
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private readDocument(): KeyringDocument {
    this.assertSupportedPlatform();
    let before: ReturnType<typeof lstatSync>;
    try {
      before = lstatSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("quarantine_keyring_missing");
      }
      throw new Error("quarantine_keyring_unavailable");
    }
    if (before.isSymbolicLink()) throw new Error("quarantine_keyring_symlink");
    if (!before.isFile()) throw new Error("quarantine_keyring_not_regular");
    this.assertPermissions(before.mode);
    if (before.size <= 0 || before.size > MAX_KEYRING_BYTES) {
      throw new Error("quarantine_keyring_invalid");
    }

    let fd: number | undefined;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size <= 0 ||
        opened.size > MAX_KEYRING_BYTES
      ) {
        throw new Error("quarantine_keyring_toctou");
      }
      this.assertPermissions(opened.mode);
      const bytes = readFileSync(fd);
      const after = fstatSync(fd);
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
        throw new Error("quarantine_keyring_toctou");
      }
      return parseKeyring(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error("quarantine_keyring_symlink");
      }
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private writeAtomically(document: KeyringDocument): void {
    this.assertSafeParent();
    const temporary = `${this.path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        KEY_MODE,
      );
      fchmodSync(fd, KEY_MODE);
      writeSync(fd, JSON.stringify(document));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path);
      this.syncParent();
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }

  private acquireLock(lockPath: string): number {
    this.assertSafeParent();
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const fd = openSync(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          KEY_MODE,
        );
        fchmodSync(fd, KEY_MODE);
        return fd;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        pause();
      }
    }
    throw new Error("quarantine_keyring_busy");
  }

  private assertSafeParent(): void {
    const parent = dirname(this.path);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("quarantine_keyring_parent_unsafe");
    }
  }

  private assertSupportedPlatform(): void {
    if (process.platform === "win32") {
      throw new Error("quarantine_keyring_platform_unsupported");
    }
  }

  private assertPermissions(mode: number): void {
    if ((mode & 0o777) !== KEY_MODE) throw new Error("quarantine_keyring_permissions");
  }

  private syncParent(): void {
    let fd: number | undefined;
    try {
      fd = openSync(dirname(this.path), constants.O_RDONLY);
      fsyncSync(fd);
    } catch {
      // The atomic rename is still authoritative where directory fsync is unavailable.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

function digestSourceWithKey(
  source: QuarantineSourceIdentity,
  payloadFingerprint: string,
  active: ActiveKey,
): QuarantineDigest {
  if (!isPayloadFingerprint(payloadFingerprint)) {
    throw new Error("quarantine_payload_fingerprint_invalid");
  }
  return {
    keyID: active.keyID,
    digest: createHmac("sha256", active.key)
      .update(sourceDigestBytes(source, payloadFingerprint))
      .digest("hex"),
  };
}

function parseKeyring(bytes: Buffer): KeyringDocument {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("quarantine_keyring_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("quarantine_keyring_invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.format !== KEYRING_FORMAT ||
    typeof record.activeKeyID !== "string" ||
    !record.keys ||
    typeof record.keys !== "object" ||
    Array.isArray(record.keys) ||
    Object.keys(record).length !== 3
  ) {
    throw new Error("quarantine_keyring_invalid");
  }
  const keys = record.keys as Record<string, unknown>;
  if (!/^[0-9a-f]{24}$/.test(record.activeKeyID)) {
    throw new Error("quarantine_keyring_invalid");
  }
  for (const [keyID, encoded] of Object.entries(keys)) {
    if (
      !/^[0-9a-f]{24}$/.test(keyID) ||
      typeof encoded !== "string" ||
      !isCanonicalKey(encoded)
    ) {
      throw new Error("quarantine_keyring_invalid");
    }
  }
  if (typeof keys[record.activeKeyID] !== "string") {
    throw new Error("quarantine_keyring_invalid");
  }
  return {
    format: KEYRING_FORMAT,
    activeKeyID: record.activeKeyID,
    keys: keys as Record<string, string>,
  };
}

function isCanonicalKey(value: string): boolean {
  const key = Buffer.from(value, "base64");
  return key.length === KEY_BYTES && key.toString("base64") === value;
}

function sourceDigestBytes(source: QuarantineSourceIdentity, payloadFingerprint: string): Buffer {
  return Buffer.from(
    JSON.stringify([
      "quarantine-source-payload/2",
      source.schema,
      source.projectID,
      source.bindingKey,
      source.kind,
      source.source.system,
      source.source.opencodeVersion,
      source.source.pluginVersion,
      source.source.sessionID,
      source.source.messageID ?? null,
      source.source.ordinal ?? null,
      source.source.toolCallID ?? null,
      payloadFingerprint,
    ]),
    "utf8",
  );
}

function isPayloadFingerprint(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function isKeyringError(error: unknown, code: string): boolean {
  return error instanceof Error && error.message === code;
}

function pause(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
