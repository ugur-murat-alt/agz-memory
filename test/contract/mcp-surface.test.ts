import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { CAPTURE_SCHEMA } from "../../src/capture/contract";
import { resolveConfig } from "../../src/config";
import { openMemoryDatabase } from "../../src/db";
import { BACKUP_FORMAT } from "../../src/db/backup";
import { MEMORY_GUIDANCE } from "../../src/context";
import { formatUntrustedContext } from "../../src/retrieval/formatter";
import { createMemoryServer } from "../../src/server";
import { MemoryStore } from "../../src/store";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("MCP compatibility surface", () => {
  test("preserves persisted and configuration compatibility identifiers", () => {
    expect(CAPTURE_SCHEMA).toBe("opencode2-memory.capture/1");
    expect(BACKUP_FORMAT).toBe("opencode2-memory-backup/1");
    expect(
      formatUntrustedContext("project-id", [
        {
          id: "note-id",
          projectID: "project-id",
          projectName: "Contract",
          kind: "fact",
          title: "title",
          summary: "summary",
          sizeClass: "inline",
          pinned: false,
          via: "match",
        },
      ])?.startsWith('<opencode2-memory-context trust="untrusted" project-id="project-id">'),
    ).toBe(true);
    expect(resolveConfig({ HOME: "/tmp/agz-memory-contract-home" }).databasePath).toBe(
      "/tmp/agz-memory-contract-home/.local/share/opencode-memory/memory.sqlite",
    );
    expect(
      resolveConfig({ OPENCODE_MEMORY_DATABASE_PATH: "/custom/memory.sqlite" }).databasePath,
    ).toBe("/custom/memory.sqlite");
  });

  test("keeps initialize identity, instructions, and exact tool catalog stable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-contract-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    const server = createMemoryServer(new MemoryStore(opened.db));
    const client = new Client({ name: "contract-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    });

    expect(client.getServerVersion()).toEqual({ name: "agz-memory", version: "0.4.0-beta.1" });
    expect(client.getInstructions()).toBe(MEMORY_GUIDANCE);
    const { tools } = await client.listTools();
    expect(
      tools
        .map(({ name, title, description, inputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          annotations,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toMatchSnapshot();
  });

  test("preserves ordered non-atomic batch completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-batch-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    const store = new MemoryStore(opened.db);
    const projectID = store.createProject("Batch").project!.projectID;
    const server = createMemoryServer(store);
    const client = new Client({ name: "contract-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await server.close();
      opened.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const result = await client.callTool({
      name: "memory_update",
      arguments: {
        projectID,
        updates: [
          { kind: "fact", title: "first", summary: "first" },
          { id: "missing", title: "second" },
          { kind: "fact", title: "third", summary: "third" },
        ],
      },
    });
    const block = result.content[0];
    if (!block || block.type !== "text") throw new Error("expected text result");
    const body = JSON.parse(block.text);
    expect(body.results.map((entry: { ok: boolean }) => entry.ok)).toEqual([true, false, true]);
  });
});
