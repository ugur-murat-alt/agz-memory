import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { createMigrationTimingCollector, openMemoryDatabase, type MigrationTiming } from "../src/db";
import { createDataBearingLegacyV2 } from "../test/db/legacy-v2-fixture";

const args = process.argv.slice(2);
const iterations = Number(args[args.indexOf("--iterations") + 1] ?? 1);
const jsonPath = args[args.indexOf("--json") + 1];
const assertP95 = args.includes("--assert-p95");
if (!Number.isInteger(iterations) || iterations < 1 || !jsonPath) throw new Error("usage: --iterations N --json PATH [--assert-p95]");

const slaMs = process.platform === "win32" ? 2_500 : 1_500;
const elapsed: number[] = [];
const samples: Array<MigrationTiming & { totalElapsedMs: number; unattributedMs: number }> = [];
for (let index = 0; index < iterations; index++) {
  const directory = mkdtempSync(join(tmpdir(), "agz-memory-migration-timing-"));
  const path = join(directory, "memory.sqlite");
  try {
    createDataBearingLegacyV2(path);
    const timing = createMigrationTimingCollector();
    const started = performance.now();
    const opened = openMemoryDatabase(path, { timing });
    opened.close();
    const totalElapsedMs = Math.round((performance.now() - started) * 1000) / 1000;
    elapsed.push(totalElapsedMs);
    const stageElapsedMs = timing.phases.reduce((total, phase) => total + phase.elapsedMs, 0);
    samples.push({ ...timing, totalElapsedMs, unattributedMs: Math.max(0, totalElapsedMs - stageElapsedMs) });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const p95Ms = [...elapsed].sort((left, right) => left - right)[Math.ceil(elapsed.length * 0.95) - 1]!;
const result = { bun: Bun.version, platform: process.platform, sha: process.env.GITHUB_SHA ?? "local", iterations, slaMs, p95Ms, samples };
writeFileSync(jsonPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
if (assertP95 && p95Ms > slaMs) {
  const slowestSample = samples[elapsed.indexOf(Math.max(...elapsed))]!;
  const slowest = [...slowestSample.phases, { stage: "unattributed", elapsedMs: slowestSample.unattributedMs }]
    .reduce((largest, contribution) => contribution.elapsedMs > largest.elapsedMs ? contribution : largest);
  const failure = { bun: Bun.version, platform: process.platform, sha: process.env.GITHUB_SHA ?? "local", stage: slowest.stage, elapsedMs: slowest.elapsedMs, slaMs, p95Ms };
  writeFileSync(join(dirname(jsonPath), "failure-timing.json"), `${JSON.stringify(failure)}\n`, { mode: 0o600 });
  throw new Error(`migration p95 ${p95Ms}ms exceeds ${slaMs}ms at ${slowest.stage}`);
}
