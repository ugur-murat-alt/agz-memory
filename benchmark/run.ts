import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openMemoryDatabase } from "../src/db";
import { RetrievalStore } from "../src/store/retrieval";

const size = Number(process.argv[2] ?? 10_000);
const queryCount = Number(process.argv[3] ?? 100);
if (!Number.isInteger(size) || size < 1 || size > 100_000) throw new Error("size must be 1..100000");
if (!Number.isInteger(queryCount) || queryCount < 1 || queryCount > 1_000) {
  throw new Error("query count must be 1..1000");
}

const directory = mkdtempSync(join(tmpdir(), "opencode2-memory-benchmark-"));
const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
const projectID = "11111111-1111-4111-8111-111111111111";
const now = Date.now();
opened.db
  .query(
    "INSERT INTO projects (id, name, normalized_name, created_at, updated_at) VALUES (?, 'Benchmark', 'benchmark', ?, ?)",
  )
  .run(projectID, now, now);
const insert = opened.db.query(`
  INSERT INTO notes
    (id, project_id, kind, title, summary, content, size_class, pinned, status,
     current_revision, content_hash, created_at, updated_at)
  VALUES (?, ?, 'fact', ?, ?, ?, 'inline', 0, 'active', 1, ?, ?, ?)
`);
opened.db.transaction(() => {
  for (let index = 0; index < size; index++) {
    const text = `benchmark token-${index % 1_000} durable fact ${index}`;
    const hash = createHash("sha256").update(`fact\0${text}\0${text}\0${text}`).digest("hex");
    insert.run(`note-${index.toString().padStart(6, "0")}`, projectID, text, text, text, hash, now + index, now + index);
  }
})();

const retrieval = new RetrievalStore(opened.db);
const samples: number[] = [];
for (let index = 0; index < queryCount; index++) {
  const started = performance.now();
  const result = await retrieval.retrieve({
    projectID,
    query: `token-${index % 1_000}`,
    limit: 8,
    deadlineAt: Date.now() + 1_000,
    semantic: "off",
  });
  if (result.cards.length === 0) throw new Error("benchmark query returned no cards");
  samples.push(performance.now() - started);
}
samples.sort((a, b) => a - b);
const percentile = (value: number) => samples[Math.min(samples.length - 1, Math.ceil(samples.length * value) - 1)]!;
process.stdout.write(
  `${JSON.stringify(
    {
      schema: "opencode2-memory.benchmark/1",
      records: size,
      queries: queryCount,
      latencyMs: {
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
      },
      semanticBackend: "none",
    },
    null,
    2,
  )}\n`,
);
opened.close();
rmSync(directory, { recursive: true, force: true });
