import { describe, expect, test } from "bun:test";
import { decodeCursor, encodeCursor, paginate } from "../../src/contracts/pagination";

describe("snapshot pagination", () => {
  test("binds cursors to project, query, and snapshot", () => {
    const cursor = encodeCursor({ projectID: "p", query: "q", snapshot: "etag", offset: 2 });
    expect(decodeCursor(cursor, { projectID: "p", query: "q", snapshot: "etag" })).toEqual({ offset: 2 });
    expect(() => decodeCursor(cursor, { projectID: "other", query: "q", snapshot: "etag" })).toThrow("cursor_scope_mismatch");
    expect(() => decodeCursor("bad", { projectID: "p", query: "q", snapshot: "etag" })).toThrow("invalid_cursor");
  });

  test("keeps an ETag/snapshot chain and caps page size", () => {
    const first = paginate(["a", "b", "c"], { projectID: "p", query: "q", limit: 2, snapshot: "etag" });
    expect(first).toEqual({ items: ["a", "b"], snapshot: "etag", etag: "etag", nextCursor: expect.any(String) });
    const second = paginate(["a", "b", "c"], { projectID: "p", query: "q", limit: 99, snapshot: "etag", cursor: first.nextCursor });
    expect(second.items).toEqual(["c"]);
    expect(second.nextCursor).toBeUndefined();
  });

  test("rejects a client snapshot that differs from the current snapshot", () => {
    expect(() => paginate(["a"], {
      projectID: "p",
      query: "q",
      limit: 1,
      snapshot: "current",
      requestedSnapshot: "client",
    })).toThrow("stale_snapshot");
  });
});
