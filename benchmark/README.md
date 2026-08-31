# Retrieval Benchmark

The benchmark area contains only anonymized/redacted fixtures and aggregate
results. Never copy the production SQLite database or raw session transcripts
here.

Production semantic retrieval is currently `none`. A backend can be enabled
only after exact-version contract tests prove server-side project filtering,
idempotent upsert, deterministic delete, full project purge, health behavior,
zero cross-project/secret leakage, rebuild parity, and the quality/latency gates
defined in the architecture plan.

`corpus.schema.json` defines the allowed JSONL record shape. It excludes paths,
project names, prompts, reasoning, tool payloads, and provenance.
