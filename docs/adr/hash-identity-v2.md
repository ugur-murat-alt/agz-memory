# ADR: Version 2 Tuple Hash Identities

Status: Accepted

Date: 2026-09-02

## Context

Schema 10 hashes several user-controlled tuples by joining strings with NUL bytes. NUL is not rejected by every producer, so two different tuples can serialize to the same byte sequence. JavaScript string length also counts UTF-16 code units rather than UTF-8 bytes, which makes an implicit character-based framing contract unsuitable for persisted identities.

The affected values include canonical note hashes, derived-document hashes, OpenCode capture identities, project binding keys, and capture payload hashes. These values survive process restarts and must be deterministic on every supported platform.

## Decision

Schema 11 uses one exported helper:

```ts
hashTuple(domain, version, fields)
```

The encoder writes the following byte sequence into SHA-256:

1. A fixed `agz-memory/hash-tuple` format marker.
2. A length-prefixed UTF-8 domain.
3. An unsigned version integer.
4. A field count.
5. For every field, a one-byte type tag, an unsigned UTF-8/byte payload length, and the payload.

`null`, strings, booleans, finite numbers, and byte arrays use distinct tags. Empty strings and `null` are therefore different. String lengths are measured after UTF-8 encoding, never with JavaScript `String.length`. Numbers use a canonical finite representation and unsafe integers are rejected.

Each use has a separate domain. The initial version 2 domains are:

- `canonical-note`
- `derived-note`
- `capture-identity`
- `capture-payload`
- `project-binding`
- `checkpoint-identity`
- `outbox-operation`

Schema 11 recomputes canonical and revision hashes from persisted source fields. Derived hashes are recomputed from `deriveDocument()`. Capture keys are recomputed from strict source identities; a legacy row that cannot satisfy its event-kind identity contract stops migration with a safe row identifier and error code. Different legacy rows mapping to the same version 2 key stop migration; they are never merged or ignored.

The capture writer emits `agz-memory.capture/2`. The migration reader accepts `/1` only while migrating persisted schema 10 rows. Runtime ingestion accepts `/2` and independently recomputes the idempotency key before insertion.

## Consequences

- NUL and Unicode tuple collision counterexamples no longer collide.
- Hashes intentionally change during the schema 10 to 11 migration.
- Version 2 databases cannot be safely written by version 0.4.1; the existing newer-schema guard must reject them before any DDL.
- Hashes identify content or operation tuples; they are not secret storage and do not replace redaction.
- Migration produces an aggregate mapping audit without recording note bodies, prompts, credentials, or other private payloads.

## Rejected Alternatives

- Delimiter escaping was rejected because every producer would need identical escaping and type/null handling.
- `JSON.stringify` was rejected because object/key representation and numeric edge cases are not the persisted contract we need.
- Reusing version 1 hashes was rejected because it preserves the collision class.
