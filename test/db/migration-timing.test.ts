import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";
import { createMigrationTimingCollector, openMemoryDatabase } from "../../src/db";
import { createDataBearingLegacyV2 } from "./legacy-v2-fixture";

const MIGRATION_SLA_MS = process.platform === "win32" ? 2_500 : 1_500;

test("records payload-free phases for a data-bearing legacy-v2 migration", () => {
  const directory = mkdtempSync(join(tmpdir(), "agz-memory-migration-timing-"));
  const path = join(directory, "memory.sqlite");
  createDataBearingLegacyV2(path);
  try {
    const timing = createMigrationTimingCollector();
    const opened = openMemoryDatabase(path, { timing });
    opened.close();
    expect(timing.phases.map((phase) => phase.stage)).toEqual([
      "source-validation", "backup-checkpoint", "v2-import", "v8-to-v9", "v9-to-v10", "v10-to-v11", "fingerprint", "deep-health",
    ]);
    expect(JSON.stringify(timing)).not.toContain(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, MIGRATION_SLA_MS * 2);

test("retains a stale maintenance gate when full legacy health validation fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "agz-memory-migration-timing-gate-"));
  const path = join(directory, "memory.sqlite");
  const gatePath = `${path}.maintenance`;
  createDataBearingLegacyV2(path, { brokenForeignKey: true });
  mkdirSync(gatePath, { mode: 0o700 });
  writeFileSync(join(gatePath, "owner.json"), `${JSON.stringify({
    ownerID: "dead-owner", pid: 999_999, processStart: "dead", hostname: hostname(), createdAt: 1, state: "active",
  })}\n`, { mode: 0o600 });
  try {
    expect(() => openMemoryDatabase(path)).toThrow("database foreign key check failed");
    expect(existsSync(gatePath)).toBe(true);
    expect(JSON.parse(readFileSync(join(gatePath, "owner.json"), "utf8"))).toMatchObject({ state: "recovery-required" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
