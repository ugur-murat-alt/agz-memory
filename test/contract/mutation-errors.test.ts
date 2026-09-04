import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { openMemoryDatabase } from "../../src/db";
import { createMemoryServer } from "../../src/server";
import { MemoryStore } from "../../src/store";
import {
  assertStrictMutationOperation,
  normalizeLegacyMutation,
  type MutationOperation,
} from "../../src/contracts/mutation";
import { businessError, correlationID, toPublicError } from "../../src/contracts/error";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function harness() {
  const directory = mkdtempSync(join(tmpdir(), "agz-memory-mutation-contract-"));
  const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
  const server = createMemoryServer(new MemoryStore(opened.db));
  const client = new Client({ name: "contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await server.close(); opened.close(); rmSync(directory, { recursive: true, force: true }); });
  const created = await client.callTool({ name: "project_create", arguments: { projectName: "Mutation" } });
  const block = created.content[0];
  if (!block || block.type !== "text") throw new Error("expected text result");
  return { client, projectID: JSON.parse(block.text).results[0].project.projectID as string };
}

describe("mutation and public-error contracts", () => {
  test("normalizes compatible legacy create and rejects contradictory mutations", () => {
    expect(normalizeLegacyMutation({ kind: "fact", title: "a", summary: "b" })).toMatchObject({
      operation: "create",
      title: "a",
    });
    expect(() => normalizeLegacyMutation({ id: "n", delete: true, title: "edit" })).toThrow(
      "cannot combine delete",
    );
    expect(() => normalizeLegacyMutation({ id: "n" })).toThrow("patch requires changes");
  });

  test("internal operation union is discriminated", () => {
    const operation: MutationOperation = { operation: "patch", id: "n", changes: { title: "next" } };
    expect(operation.operation).toBe("patch");
  });

  test("rejects an undefined-only strict patch", () => {
    expect(() => assertStrictMutationOperation({ operation: "patch", id: "n", changes: { title: undefined } })).toThrow(
      "patch requires changes",
    );
  });

  test("public business errors are stable and never expose a cause", () => {
    const id = correlationID();
    const error = businessError("not_found", "note not found", id, new Error("SQLITE_ERROR /private/db secret"));
    expect(toPublicError(error)).toEqual({ code: "not_found", correlationID: id, retryable: false, message: "note not found" });
  });

  test("maps a failed single update to an error with a correlation ID and preserves batch completion", async () => {
    const { client, projectID } = await harness();
    const single = await client.callTool({ name: "memory_update", arguments: { projectID, id: "missing", title: "next" } });
    expect(single.isError).toBe(true);
    const singleBlock = single.content[0];
    if (!singleBlock || singleBlock.type !== "text") throw new Error("expected text result");
    const error = JSON.parse(singleBlock.text).error;
    expect(error).toMatchObject({ code: "not_found", message: "memory record not found", correlationID: expect.any(String) });
    expect(singleBlock.text).not.toContain("SQLITE");

    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => { logged.push(values.join(" ")); };
    let batch: Awaited<ReturnType<Client["callTool"]>>;
    try {
      batch = await client.callTool({
        name: "memory_update",
        arguments: { projectID, updates: [
          { kind: "fact", title: "first", summary: "first" },
          { id: "missing", title: "next" },
          { kind: "fact", title: "third", summary: "third" },
        ] },
      });
    } finally {
      console.error = originalError;
    }
    expect(batch.isError).not.toBe(true);
    const batchBlock = batch.content[0];
    if (!batchBlock || batchBlock.type !== "text") throw new Error("expected text result");
    const body = JSON.parse(batchBlock.text);
    expect(body.status).toBe("partial_failure");
    expect(body.results.map((result: { ok: boolean }) => result.ok)).toEqual([true, false, true]);
    const failed = body.results[1].error;
    expect(failed).toMatchObject({ code: "not_found", correlationID: expect.any(String) });
    expect(logged.map((line) => JSON.parse(line))).toContainEqual({
      component: "mcp",
      operation: "memory_update",
      outcome: "error",
      error_code: failed.code,
      correlation_id: failed.correlationID,
    });
  });

  test("returns typed errors for failed batch links", async () => {
    const { client, projectID } = await harness();
    const create = async (title: string) => {
      const result = await client.callTool({ name: "memory_update", arguments: { projectID, kind: "fact", title, summary: title } });
      const block = result.content[0];
      if (!block || block.type !== "text") throw new Error("expected text result");
      return JSON.parse(block.text).results[0].id as string;
    };
    const first = await create("first");
    const second = await create("second");
    const batch = await client.callTool({
      name: "memory_link",
      arguments: { projectID, links: [
        { sourceID: first, targetID: second, predicate: "ABOUT" },
        { sourceID: first, targetID: "missing", predicate: "ABOUT" },
      ] },
    });
    const block = batch.content[0];
    if (!block || block.type !== "text") throw new Error("expected text result");
    const body = JSON.parse(block.text);
    expect(body.status).toBe("partial_failure");
    expect(body.results[1]).toEqual({ ok: false, error: expect.objectContaining({ code: "not_found", correlationID: expect.any(String) }) });
  });
});
