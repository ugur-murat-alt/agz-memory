import { createHash } from "crypto";

export type HashTupleValue = null | string | boolean | number | Uint8Array;

const HASH_TUPLE_MARKER = Buffer.from("agz-memory/hash-tuple", "utf8");
const MAX_UINT32 = 0xffff_ffff;

export function hashTuple(
  domain: string,
  version: number,
  fields: readonly HashTupleValue[],
): string {
  if (typeof domain !== "string") throw new TypeError("hash tuple domain must be a string");
  if (!Number.isSafeInteger(version) || version < 0 || version > MAX_UINT32) {
    throw new RangeError("hash tuple version must be an unsigned safe integer");
  }
  if (!Array.isArray(fields)) throw new TypeError("hash tuple fields must be an array");
  if (fields.length > MAX_UINT32) throw new RangeError("hash tuple has too many fields");

  const domainBytes = utf8(domain);
  const chunks: Buffer[] = [
    HASH_TUPLE_MARKER,
    lengthPrefix(domainBytes),
    uint32(version),
    uint32(fields.length),
  ];

  for (const field of fields) {
    const encoded = encodeField(field);
    chunks.push(Buffer.from([encoded.tag]), lengthPrefix(encoded.payload));
  }

  return createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
}

export function noteContentHash(
  kind: string,
  title: string,
  summary: string,
  content: string,
): string {
  return hashTuple("canonical-note", 2, [kind, title, summary, content]);
}

export const canonicalNoteHash = noteContentHash;

function encodeField(value: HashTupleValue): { tag: number; payload: Buffer } {
  if (value === null) return { tag: 0x00, payload: Buffer.alloc(0) };
  if (typeof value === "string") return { tag: 0x01, payload: utf8(value) };
  if (typeof value === "boolean") return { tag: 0x02, payload: Buffer.from([value ? 1 : 0]) };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("hash tuple numbers must be finite");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new RangeError("hash tuple integer numbers must be safe");
    }
    return { tag: 0x03, payload: utf8(String(value)) };
  }
  if (value instanceof Uint8Array) return { tag: 0x04, payload: Buffer.from(value) };
  throw new TypeError("hash tuple field has an unsupported type");
}

function utf8(value: string): Buffer {
  if (!isWellFormedUnicode(value)) {
    throw new TypeError("hash tuple strings must be well-formed Unicode");
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > MAX_UINT32) throw new RangeError("hash tuple field is too large");
  return bytes;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function lengthPrefix(bytes: Uint8Array): Buffer {
  return Buffer.concat([uint32(bytes.length), Buffer.from(bytes)]);
}

function uint32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value, 0);
  return result;
}
