import { LIMITS } from "./limits";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const CURSOR_VERSION = 1;
const CURSOR_KEY = randomBytes(32); // Process-local: cursors intentionally expire after server restart.
const MAX_CURSOR_BYTES = 2_048;

export interface CursorScope {
  projectID: string;
  query: string;
  snapshot: string;
}

interface CursorPayload extends CursorScope {
  v: 1;
  offset: number;
}

export interface PageOptions extends CursorScope {
  limit: number;
  cursor?: string;
  /** Snapshot returned by the client on a follow-up request. */
  requestedSnapshot?: string;
}

export interface Page<T> {
  items: T[];
  snapshot: string;
  etag: string;
  nextCursor?: string;
}

export function encodeCursor(payload: Omit<CursorPayload, "v">): string {
  const body = Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...payload }));
  const signature = createHmac("sha256", CURSOR_KEY).update(body).digest();
  return Buffer.concat([body, signature]).toString("base64url");
}

export function decodeCursor(cursor: string, scope: CursorScope): { offset: number } {
  let payload: CursorPayload;
  try {
    if (Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES) throw new Error();
    const encoded = Buffer.from(cursor, "base64url");
    if (encoded.length <= 32) throw new Error();
    const body = encoded.subarray(0, -32);
    const signature = encoded.subarray(-32);
    const expected = createHmac("sha256", CURSOR_KEY).update(body).digest();
    if (!timingSafeEqual(signature, expected)) throw new Error();
    payload = JSON.parse(body.toString("utf8")) as CursorPayload;
  } catch {
    throw new TypeError("invalid_cursor");
  }
  if (payload.v !== CURSOR_VERSION || !Number.isSafeInteger(payload.offset) || payload.offset < 0) throw new TypeError("invalid_cursor");
  if (payload.projectID !== scope.projectID || payload.query !== scope.query) {
    throw new TypeError("cursor_scope_mismatch");
  }
  if (payload.snapshot !== scope.snapshot) throw new TypeError("stale_snapshot");
  return { offset: payload.offset };
}

export function paginate<T>(items: readonly T[], options: PageOptions): Page<T> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new RangeError("page limit must be positive");
  if (options.requestedSnapshot !== undefined && options.requestedSnapshot !== options.snapshot) {
    throw new TypeError("stale_snapshot");
  }
  const offset = options.cursor !== undefined ? decodeCursor(options.cursor, options).offset : 0;
  const limit = Math.min(options.limit, LIMITS.pageSize);
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    snapshot: options.snapshot,
    etag: options.snapshot,
    ...(nextOffset < items.length
      ? { nextCursor: encodeCursor({ projectID: options.projectID, query: options.query, snapshot: options.snapshot, offset: nextOffset }) }
      : {}),
  };
}
