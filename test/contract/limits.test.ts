import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openMemoryDatabase } from "../../src/db";
import { MemoryStore } from "../../src/store";
import {
  LIMITS,
  assertTextLimit,
  utf8Bytes,
} from "../../src/contracts/limits";

describe("shared contract limits", () => {
  test("measures text in UTF-8 bytes, not UTF-16 code units", () => {
    expect(utf8Bytes("😀")).toBe(4);
    expect(() => assertTextLimit("title", "😀".repeat(61))).toThrow("title exceeds");
    expect(() => assertTextLimit("title", "a".repeat(LIMITS.title + 1))).toThrow("title exceeds");
  });

  test("publishes bounded request and response limits", () => {
    expect(LIMITS.batch).toBe(10);
    expect(LIMITS.requestBytes).toBeGreaterThan(LIMITS.content);
    expect(LIMITS.responseBytes).toBeGreaterThan(0);
  });

  test("enforces byte limits in the store and never returns more than recall's requested limit", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-limit-contract-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    try {
      const store = new MemoryStore(opened.db);
      const projectID = store.createProject("Limits").project!.projectID;
      expect(() => store.update(projectID, { operation: "create", kind: "fact", title: "😀".repeat(61), summary: "summary" })).toThrow("title exceeds");
      store.update(projectID, { operation: "create", kind: "fact", title: "match one", summary: "match" });
      store.update(projectID, { operation: "create", kind: "fact", title: "match two", summary: "match" });
      expect(store.recall(projectID, "match", 1)).toHaveLength(1);
    } finally {
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("bounds default reads and exposes deterministic edge paging", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-edge-contract-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    try {
      const store = new MemoryStore(opened.db);
      const projectID = store.createProject("Edges").project!.projectID;
      const source = store.update(projectID, { operation: "create", kind: "fact", title: "source", summary: "source" }).id!;
      for (let index = 0; index < 101; index++) {
        const target = store.update(projectID, { operation: "create", kind: "fact", title: `target ${index}`, summary: "target" }).id!;
        expect(store.link(projectID, source, target, "ABOUT").ok).toBe(true);
      }
      const first = store.read(projectID, source);
      expect(first.edges).toHaveLength(100);
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(first.edges).toEqual([...first.edges ?? []].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)));
      const second = store.readPage(projectID, source, 100, first.nextCursor, first.snapshot);
      expect("items" in second && second.items).toHaveLength(1);
    } finally {
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
