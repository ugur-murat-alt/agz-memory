import { existsSync, writeFileSync } from "fs";
import { runResumableReindex } from "../../src/admin/reindex";
import { openMemoryDatabase } from "../../src/db";

const path = required("AGZ_REINDEX_DATABASE");
const start = required("AGZ_REINDEX_START");
const worker = required("AGZ_REINDEX_WORKER");

const opened = openMemoryDatabase(path);
try {
  const databaseID = (opened.db.query("SELECT database_id FROM agz_meta WHERE id = 1").get() as { database_id: string }).database_id;
  opened.close();
  writeFileSync(`${start}.ready-${worker}`, "ready\n");
  while (!existsSync(start)) await Bun.sleep(5);
  runResumableReindex(path, databaseID, "owner-race", 100, undefined, {
    beforeStaleLockTakeover: process.env.AGZ_REINDEX_STALE_BARRIER === "1" ? () => {
      writeFileSync(`${start}.observed-${worker}`, "observed\n");
      while (!existsSync(`${start}.takeover`)) Bun.sleepSync(5);
    } : undefined,
    afterOwnerLockAcquired: process.env.AGZ_REINDEX_HOLD_OWNER === "1" ? () => {
      writeFileSync(`${start}.acquired-${worker}`, "acquired\n");
      while (!existsSync(`${start}.release`)) Bun.sleepSync(5);
    } : undefined,
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  try { opened.close(); } catch { /* closed above on the success path */ }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
