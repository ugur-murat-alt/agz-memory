import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { openMemoryDatabase } from "../src/db";
import { createMemoryServer } from "../src/server";
import { MemoryStore } from "../src/store";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), "agz-memory-"));
  const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
  const server = createMemoryServer(new MemoryStore(opened.db));
  const client = new Client({ name: "agz-memory-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    opened.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return client;
}

function parseTextResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected text tool result");
  if (result.isError) throw new Error(block.text);
  return JSON.parse(block.text);
}

function parseErrorResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected text tool result");
  expect(result.isError).toBe(true);
  return JSON.parse(block.text);
}

async function createProject(client: Client, name: string): Promise<string> {
  const body = parseTextResult(
    await client.callTool({ name: "project_create", arguments: { projectName: name } }),
  );
  expect(body.results[0].ok).toBe(true);
  return body.results[0].project.projectID;
}

async function createNote(
  client: Client,
  project: { projectID: string } | { projectName: string },
  title: string,
): Promise<string> {
  const body = parseTextResult(
    await client.callTool({
      name: "memory_update",
      arguments: {
        ...project,
        kind: "fact",
        title,
        summary: `${title} summary`,
        content: `${title} body`,
      },
    }),
  );
  expect(body.results[0].ok).toBe(true);
  return body.results[0].id;
}

function createPreV6Database(path: string, version: number, withPinned: boolean) {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, summary TEXT NOT NULL, content TEXT NOT NULL,
      size_class TEXT NOT NULL${withPinned ? ", pinned INTEGER NOT NULL DEFAULT 0" : ""},
      status TEXT NOT NULL, supersedes_id TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE note_edges (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_id TEXT NOT NULL,
      target_id TEXT NOT NULL, predicate TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE schema_state (version INTEGER PRIMARY KEY);
    INSERT INTO schema_state VALUES (${version});
  `);
  const columns = withPinned
    ? "id, project_id, kind, title, summary, content, size_class, pinned, status, supersedes_id, created_at, updated_at"
    : "id, project_id, kind, title, summary, content, size_class, status, supersedes_id, created_at, updated_at";
  const values = withPinned
    ? "'note-1', 'old-project', 'fact', 'old note', 'old summary', 'old content', 'inline', 1, 'active', NULL, 1, 2"
    : "'note-1', 'old-project', 'fact', 'old note', 'old summary', 'old content', 'inline', 'active', NULL, 1, 2";
  db.exec(`INSERT INTO notes (${columns}) VALUES (${values})`);
  db.close();
}

describe("project-scoped memory MCP server", () => {
  test("migrates core legacy notes into a UUID project", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-legacy-"));
    const databasePath = join(directory, "memory.sqlite");
    const legacy = new Database(databasePath, { create: true });
    legacy.exec(`
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY, identity_id TEXT NOT NULL, subject_key TEXT NOT NULL,
        kind TEXT NOT NULL, lifecycle_state TEXT NOT NULL, current_version_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE memory_versions (id TEXT PRIMARY KEY, summary TEXT, content TEXT);
      CREATE TABLE memory_identities (id TEXT PRIMARY KEY, project_id TEXT);
      CREATE TABLE document_sources (
        id TEXT PRIMARY KEY, project_root TEXT, title TEXT, created_at INTEGER,
        updated_at INTEGER, status TEXT
      );
      CREATE TABLE document_chunks (source_id TEXT, memory_id TEXT);
      CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT);
      INSERT INTO memory_identities VALUES ('identity-1', 'legacy-project');
      INSERT INTO memory_versions VALUES ('version-1', 'legacy summary', 'legacy content');
      INSERT INTO memory_items VALUES (
        'research-source-1', 'identity-1', 'legacy title', 'fact', 'active', 'version-1', 1, 2
      );
      INSERT INTO document_sources VALUES ('source-1', NULL, 'legacy document', 1, 2, 'active');
      INSERT INTO document_chunks VALUES ('source-1', 'memory-1');
      INSERT INTO memories VALUES ('memory-1', 'document content');
    `);
    legacy.close();

    const migrated = openMemoryDatabase(databasePath);
    const note = migrated.db
      .query(
        `SELECT n.title, n.pinned, p.id AS project_id, p.name AS project_name
           FROM notes n JOIN projects p ON p.id = n.project_id WHERE n.id = ?`,
      )
      .get("research-source-1") as {
      title: string;
      pinned: number;
      project_id: string;
      project_name: string;
    };
    expect(note.title).toBe("legacy title");
    expect(note.pinned).toBe(0);
    expect(note.project_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(note.project_name).toBe("Legacy legacy-proje");
    expect((migrated.db.query("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count).toBe(2);
    expect((migrated.db.query("SELECT COUNT(*) AS count FROM notes_fts").get() as { count: number }).count).toBe(2);
    expect(existsSync(`${databasePath}.v2-backup`)).toBe(true);
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("migrates v5 notes and rebuilds project-scoped search", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-v5-"));
    const databasePath = join(directory, "memory.sqlite");
    createPreV6Database(databasePath, 5, false);

    const migrated = openMemoryDatabase(databasePath);
    const project = migrated.db.query("SELECT id FROM projects").get() as { id: string };
    const store = new MemoryStore(migrated.db);
    expect(store.recall(project.id, "old")[0]).toMatchObject({ title: "old note", pinned: false });
    const columns = migrated.db.query("PRAGMA table_info(notes)").all() as Array<{ name: string }>;
    expect(columns.some(({ name }) => name === "pinned")).toBe(true);
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("preserves pin state from an older schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-pinned-"));
    const databasePath = join(directory, "memory.sqlite");
    createPreV6Database(databasePath, 4, true);
    const migrated = openMemoryDatabase(databasePath);
    const row = migrated.db.query("SELECT pinned FROM notes WHERE id = 'note-1'").get() as {
      pinned: number;
    };
    expect(row.pinned).toBe(1);
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("rekeys existing non-UUID projects without changing their names", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-project-id-"));
    const databasePath = join(directory, "memory.sqlite");
    createPreV6Database(databasePath, 6, false);
    const old = new Database(databasePath);
    old.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO projects VALUES ('old-project', 'Existing Name', 'existing name', 1, 2);
    `);
    old.close();

    const migrated = openMemoryDatabase(databasePath);
    const project = migrated.db.query("SELECT id, name FROM projects").get() as {
      id: string;
      name: string;
    };
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project.name).toBe("Existing Name");
    expect(
      (migrated.db.query("SELECT project_id FROM notes WHERE id = 'note-1'").get() as {
        project_id: string;
      }).project_id,
    ).toBe(project.id);
    const store = new MemoryStore(migrated.db);
    const secondProjectID = store.createProject("Second").project!.projectID;
    const secondNoteID = store.update(secondProjectID, {
      operation: "create",
      kind: "fact",
      title: "second",
      summary: "second",
    }).id!;
    expect(() =>
      migrated.db
        .query(
          "INSERT INTO note_edges (id, project_id, source_id, target_id, predicate, created_at) VALUES ('old-v6-bad-edge', ?, 'note-1', ?, 'ABOUT', 1)",
        )
        .run(project.id, secondNoteID),
    ).toThrow();
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("rejects a database created by a newer schema without adding tables", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-newer-"));
    const databasePath = join(directory, "memory.sqlite");
    const newer = new Database(databasePath, { create: true });
    newer.exec("CREATE TABLE schema_state (version INTEGER PRIMARY KEY); INSERT INTO schema_state VALUES (99)");
    newer.close();
    expect(() => openMemoryDatabase(databasePath)).toThrow(
      "database schema v99 is newer than supported v11",
    );
    const unchanged = new Database(databasePath, { readonly: true });
    const notes = unchanged
      .query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'notes'")
      .get() as { count: number };
    expect(notes.count).toBe(0);
    unchanged.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("imports same-project legacy associations while upgrading v7", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-associations-"));
    const databasePath = join(directory, "memory.sqlite");
    const alphaID = "11111111-1111-4111-8111-111111111111";
    const betaID = "22222222-2222-4222-8222-222222222222";
    const first = "note-first";
    const second = "note-second";
    const other = "note-other";
    const legacy = new Database(databasePath, { create: true });
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE notes (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, content TEXT NOT NULL,
        size_class TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
        supersedes_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(project_id, id)
      );
      CREATE INDEX notes_project_idx ON notes(project_id, status);
      CREATE TABLE note_edges (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL, target_id TEXT NOT NULL, predicate TEXT NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE(project_id, source_id, target_id, predicate),
        FOREIGN KEY (project_id, source_id) REFERENCES notes(project_id, id) ON DELETE CASCADE,
        FOREIGN KEY (project_id, target_id) REFERENCES notes(project_id, id) ON DELETE CASCADE
      );
      CREATE INDEX note_edges_source_idx ON note_edges(project_id, source_id);
      CREATE INDEX note_edges_target_idx ON note_edges(project_id, target_id);
      CREATE VIRTUAL TABLE notes_fts USING fts5(
        id UNINDEXED, title, summary, content, tokenize='unicode61'
      );
      CREATE TABLE schema_state (version INTEGER PRIMARY KEY);
      CREATE TABLE memory_associations (
        id TEXT PRIMARY KEY, left_item_id TEXT NOT NULL, right_item_id TEXT NOT NULL,
        kind TEXT NOT NULL, lifecycle_state TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      INSERT INTO schema_state VALUES (7);
    `);
    legacy.query("INSERT INTO projects VALUES (?, 'Alpha', 'alpha', 1, 1)").run(alphaID);
    legacy.query("INSERT INTO projects VALUES (?, 'Beta', 'beta', 1, 1)").run(betaID);
    const insertNote = legacy.query(
      "INSERT INTO notes VALUES (?, ?, 'fact', ?, ?, '', 'inline', 0, 'active', NULL, 1, 1)",
    );
    insertNote.run(first, alphaID, "first", "first");
    insertNote.run(second, alphaID, "second", "second");
    insertNote.run(other, betaID, "other", "other");
    legacy
      .query("INSERT INTO memory_associations VALUES ('same', ?, ?, 'SUPPORTS', 'active', 1)")
      .run(first, second);
    legacy
      .query("INSERT INTO memory_associations VALUES ('cross', ?, ?, 'related', 'active', 1)")
      .run(first, other);
    legacy.close();

    const migrated = openMemoryDatabase(databasePath);
    const edges = migrated.db
      .query("SELECT source_id, target_id, predicate FROM note_edges ORDER BY id")
      .all();
    expect(edges).toEqual([{ source_id: first, target_id: second, predicate: "SUPPORTS" }]);
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("publishes nine tools with explicit destructive project deletion", async () => {
    const client = await createHarness();
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name).sort()).toEqual([
      "memory_link",
      "memory_pin",
      "memory_read",
      "memory_recall",
      "memory_update",
      "project_create",
      "project_delete",
      "project_list",
      "project_update",
    ]);
    expect(
      Object.fromEntries(tools.map(({ name, annotations }) => [name, annotations])),
    ).toEqual({
      memory_link: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      memory_pin: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      memory_read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      memory_recall: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      memory_update: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      project_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      project_delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      project_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      project_update: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    });
    const deletion = tools.find(({ name }) => name === "project_delete")!;
    expect(deletion.annotations?.destructiveHint).toBe(true);
    expect(
      tools.find(({ name }) => name === "memory_update")!.annotations?.destructiveHint,
    ).toBe(true);
    expect(deletion.inputSchema.required).toEqual([
      "projectID",
      "confirmProjectName",
      "confirmation",
    ]);
    for (const name of ["memory_link", "memory_pin", "memory_read", "memory_recall", "memory_update"]) {
      const schema = tools.find((tool) => tool.name === name)!.inputSchema;
      expect(schema.anyOf).toBeArray();
    }

    const projectID = await createProject(client, "Selector Test");
    const bothSelectors = await client.callTool({
      name: "memory_recall",
      arguments: {
        projectID,
        projectName: "Selector Test",
        query: "x",
      },
    });
    expect(bothSelectors.isError).toBe(true);
    const tooManyQueries = await client.callTool({
      name: "memory_recall",
      arguments: { projectID, queries: Array.from({ length: 11 }, () => "x") },
    });
    expect(tooManyQueries.isError).toBe(true);
  });

  test("creates, lists, and safely renames projects", async () => {
    const client = await createHarness();
    const alphaID = await createProject(client, "Alpha");
    await createProject(client, "Beta");
    const stableNote = await createNote(client, { projectID: alphaID }, "stable project note");

    const duplicate = parseErrorResult(
      await client.callTool({ name: "project_create", arguments: { projectName: " alpha " } }),
    );
    expect(duplicate.error).toMatchObject({ code: "conflict", retryable: false });

    const renamed = parseTextResult(
      await client.callTool({
        name: "project_update",
        arguments: { projectID: alphaID, projectName: "Gamma" },
      }),
    );
    expect(renamed.results[0].project).toMatchObject({
      projectID: alphaID,
      projectName: "Gamma",
    });

    const oldName = parseErrorResult(
      await client.callTool({ name: "memory_recall", arguments: { projectName: "Alpha", query: "x" } }),
    );
    expect(oldName.error).toMatchObject({ code: "not_found", retryable: false });
    const noteID = await createNote(client, { projectName: "gamma" }, "rename-safe note");
    expect(noteID).toBeString();
    const stableRead = parseTextResult(
      await client.callTool({
        name: "memory_read",
        arguments: { projectID: alphaID, id: stableNote },
      }),
    );
    expect(stableRead.results[0].result.note.projectName).toBe("Gamma");

    const listed = parseTextResult(
      await client.callTool({ name: "project_list", arguments: {} }),
    );
    expect(
      listed.projects.map(({ projectName }: { projectName: string }) => projectName),
    ).toEqual(["Beta", "Gamma"]);
  });

  test("paginates recall beyond the requested first page and rejects stale snapshots", async () => {
    const client = await createHarness();
    const projectID = await createProject(client, "Recall pages");
    const firstNote = await createNote(client, { projectID }, "needle first");
    const secondNote = await createNote(client, { projectID }, "needle second");
    const first = parseTextResult(await client.callTool({
      name: "memory_recall",
      arguments: { projectID, query: "needle", limit: 1 },
    })).results[0];
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = parseTextResult(await client.callTool({
      name: "memory_recall",
      arguments: { projectID, query: "needle", limit: 1, cursor: first.nextCursor, snapshot: first.snapshot },
    })).results[0];
    expect([first.cards[0].id, second.cards[0].id].sort()).toEqual([firstNote, secondNote].sort());

    await createNote(client, { projectID }, "needle third");
    const stale = parseErrorResult(await client.callTool({
      name: "memory_recall",
      arguments: { projectID, query: "needle", limit: 1, cursor: first.nextCursor, snapshot: first.snapshot },
    }));
    expect(stale.error.code).toBe("stale_cursor");
  });

  test("does not revive a stale recall cursor when a project is renamed away and back", async () => {
    const client = await createHarness();
    const projectID = await createProject(client, "Rename snapshot A");
    await createNote(client, { projectID }, "renamecursor first");
    await createNote(client, { projectID }, "renamecursor second");
    const first = parseTextResult(await client.callTool({
      name: "memory_recall",
      arguments: { projectID, query: "renamecursor", limit: 1 },
    })).results[0];
    const listed = parseTextResult(await client.callTool({ name: "project_list", arguments: {} }));
    const project = listed.projects.find((item: { projectID: string }) => item.projectID === projectID);
    const originalNow = Date.now;
    Date.now = () => project.updatedAt;
    try {
      await createNote(client, { projectID }, "renamecursor third");
      await client.callTool({
        name: "project_update",
        arguments: { projectID, projectName: "Rename snapshot B" },
      });
      await client.callTool({
        name: "project_update",
        arguments: { projectID, projectName: "Rename snapshot A" },
      });
      const stale = parseErrorResult(await client.callTool({
        name: "memory_recall",
        arguments: {
          projectID,
          query: "renamecursor",
          limit: 1,
          cursor: first.nextCursor,
          snapshot: first.snapshot,
        },
      }));
      expect(stale.error.code).toBe("stale_cursor");
    } finally {
      Date.now = originalNow;
    }
  });

  test("keeps every direct recall match reachable beyond the first 101 candidates", async () => {
    const client = await createHarness();
    const projectID = await createProject(client, "Large recall pages");
    const createdIDs: string[] = [];
    for (let offset = 0; offset < 102; offset += 10) {
      const updates = Array.from({ length: Math.min(10, 102 - offset) }, (_, index) => ({
        kind: "fact",
        title: `paginationneedle ${String(offset + index).padStart(3, "0")}`,
        summary: "paginationneedle",
      }));
      const created = parseTextResult(await client.callTool({
        name: "memory_update",
        arguments: { projectID, updates },
      }));
      createdIDs.push(...created.results.map(({ id }: { id: string }) => id));
    }

    const first = parseTextResult(await client.callTool({
      name: "memory_recall",
      arguments: { projectID, query: "paginationneedle", limit: 100 },
    })).results[0];
    const second = parseTextResult(await client.callTool({
      name: "memory_recall",
      arguments: {
        projectID,
        query: "paginationneedle",
        limit: 100,
        cursor: first.nextCursor,
        snapshot: first.snapshot,
      },
    })).results[0];
    const recalledIDs = [...first.cards, ...second.cards].map(({ id }: { id: string }) => id);
    expect(first.cards).toHaveLength(100);
    expect(second.cards).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set(recalledIDs)).toEqual(new Set(createdIDs));
  });

  test("rejects an empty cursor on every paginated tool", async () => {
    const client = await createHarness();
    const projectID = await createProject(client, "Empty cursor");
    const noteID = await createNote(client, { projectID }, "empty cursor note");
    for (const request of [
      { name: "project_list", arguments: { cursor: "" } },
      { name: "memory_recall", arguments: { projectID, query: "empty", cursor: "" } },
      { name: "memory_read", arguments: { projectID, id: noteID, cursor: "" } },
    ]) {
      const body = parseErrorResult(await client.callTool(request));
      expect(body.error).toMatchObject({ code: "invalid_cursor", retryable: false });
    }
  });

  test("invalidates a project-list page when its returned note counts change", async () => {
    const client = await createHarness();
    const alpha = await createProject(client, "Alpha pages");
    await createProject(client, "Beta pages");
    const first = parseTextResult(await client.callTool({ name: "project_list", arguments: { limit: 1 } }));
    expect(first.nextCursor).toEqual(expect.any(String));
    await createNote(client, { projectID: alpha }, "changes count");
    const stale = parseErrorResult(await client.callTool({
      name: "project_list",
      arguments: { limit: 1, cursor: first.nextCursor, snapshot: first.snapshot },
    }));
    expect(stale.error.code).toBe("stale_cursor");
  });

  test("bounds edges and pagination metadata in default and batch memory reads", async () => {
    const client = await createHarness();
    const projectID = await createProject(client, "Read edge pages");
    const source = await createNote(client, { projectID }, "edge source");
    const targets: string[] = [];
    for (let offset = 0; offset < 101; offset += 10) {
      const updates = Array.from({ length: Math.min(10, 101 - offset) }, (_, index) => ({
        kind: "fact",
        title: `edge target ${offset + index}`,
        summary: "edge target",
      }));
      const created = parseTextResult(await client.callTool({ name: "memory_update", arguments: { projectID, updates } }));
      const chunk = created.results.map(({ id }: { id: string }) => id);
      targets.push(...chunk);
      const linked = parseTextResult(await client.callTool({
        name: "memory_link",
        arguments: { projectID, links: chunk.map((targetID: string) => ({ sourceID: source, targetID, predicate: "ABOUT" })) },
      }));
      expect(linked.results.every(({ ok }: { ok: boolean }) => ok)).toBe(true);
    }
    const defaultRead = parseTextResult(await client.callTool({ name: "memory_read", arguments: { projectID, id: source } }));
    expect(defaultRead.results[0].result.edges).toHaveLength(100);
    expect(defaultRead.results[0].result.nextCursor).toEqual(expect.any(String));
    const batchRead = parseTextResult(await client.callTool({ name: "memory_read", arguments: { projectID, ids: [source, targets[0]] } }));
    expect(batchRead.results[0].result.edges).toHaveLength(100);
    expect(batchRead.results[0].result).toMatchObject({ snapshot: expect.any(String), etag: expect.any(String), nextCursor: expect.any(String) });
    expect(batchRead.results[1].result.edges).toHaveLength(1);
    expect(batchRead.results[1].result).toMatchObject({ snapshot: expect.any(String), etag: expect.any(String) });
  });

  test("isolates notes, search, graph, and pin state by project", async () => {
    const client = await createHarness();
    const alphaID = await createProject(client, "Alpha");
    const betaID = await createProject(client, "Beta");
    const alphaNote = await createNote(client, { projectID: alphaID }, "shared keyword alpha");
    const betaNote = await createNote(client, { projectID: betaID }, "shared keyword beta");

    const alphaRecall = parseTextResult(
      await client.callTool({
        name: "memory_recall",
        arguments: { projectID: alphaID, query: "shared" },
      }),
    );
    expect(alphaRecall.results[0].cards.map(({ id }: { id: string }) => id)).toEqual([alphaNote]);

    const prioritized = await createNote(client, { projectID: alphaID }, "shared keyword pinned");

    const wrongProjectRead = parseErrorResult(
      await client.callTool({
        name: "memory_read",
        arguments: { projectID: betaID, id: alphaNote },
      }),
    );
    expect(wrongProjectRead.error).toMatchObject({ code: "not_found", retryable: false });

    const crossProjectLink = parseErrorResult(
      await client.callTool({
        name: "memory_link",
        arguments: {
          projectID: alphaID,
          sourceID: alphaNote,
          targetID: betaNote,
          predicate: "SUPPORTS",
        },
      }),
    );
    expect(crossProjectLink.error).toMatchObject({ code: "not_found", retryable: false });

    const pinned = parseTextResult(
      await client.callTool({
        name: "memory_pin",
        arguments: { projectName: "Alpha", id: prioritized, pinned: true },
      }),
    );
    expect(pinned.results[0]).toMatchObject({ ok: true, id: prioritized, pinned: true });
    const prioritizedRecall = parseTextResult(
      await client.callTool({
        name: "memory_recall",
        arguments: { projectID: alphaID, query: "shared" },
      }),
    );
    expect(prioritizedRecall.results[0].cards[0].id).toBe(prioritized);
    const read = parseTextResult(
      await client.callTool({
        name: "memory_read",
        arguments: { projectID: alphaID, id: alphaNote },
      }),
    );
    expect(read.results[0].result.note).toMatchObject({
      projectID: alphaID,
      projectName: "Alpha",
      pinned: false,
    });
  });

  test("enforces project edge integrity and cleans project storage", () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-integrity-"));
    const opened = openMemoryDatabase(join(directory, "memory.sqlite"));
    const store = new MemoryStore(opened.db);
    const alphaID = store.createProject("Alpha").project!.projectID;
    const betaID = store.createProject("Beta").project!.projectID;
    const alphaNote = store.update(alphaID, {
      operation: "create",
      kind: "fact",
      title: "alpha",
      summary: "alpha",
    }).id!;
    const betaNote = store.update(betaID, {
      operation: "create",
      kind: "fact",
      title: "beta",
      summary: "beta",
    }).id!;

    expect(() =>
      opened.db
        .query(
          "INSERT INTO note_edges (id, project_id, source_id, target_id, predicate, created_at) VALUES ('bad-edge', ?, ?, ?, 'ABOUT', 1)",
        )
        .run(alphaID, alphaNote, betaNote),
    ).toThrow();

    store.pin(alphaID, alphaNote, true);
    opened.db.query("UPDATE notes SET updated_at = 123 WHERE id = ?").run(alphaNote);
    store.pin(alphaID, alphaNote, true);
    expect(
      (opened.db.query("SELECT updated_at FROM notes WHERE id = ?").get(alphaNote) as {
        updated_at: number;
      }).updated_at,
    ).toBe(123);
    opened.db.query("UPDATE projects SET updated_at = 123 WHERE id = ?").run(betaID);
    store.updateProject(betaID, "Beta");
    expect(
      (opened.db.query("SELECT updated_at FROM projects WHERE id = ?").get(betaID) as {
        updated_at: number;
      }).updated_at,
    ).toBe(123);
    expect(store.deleteProject(alphaID, "Alpha").ok).toBe(true);
    expect((opened.db.query("SELECT COUNT(*) AS count FROM notes WHERE project_id = ?").get(alphaID) as { count: number }).count).toBe(0);
    expect(
      (
        opened.db
          .query(
            "SELECT COUNT(*) AS count FROM notes_fts WHERE rowid = (SELECT rowid FROM notes WHERE id = ?)",
          )
          .get(alphaNote) as { count: number }
      ).count,
    ).toBe(0);
    expect(opened.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    opened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("requires exact confirmations and deletes all project memory", async () => {
    const client = await createHarness();
    const projectID = await createProject(client, "Disposable");
    const first = await createNote(client, { projectID }, "first disposable");
    const second = await createNote(client, { projectID }, "second disposable");
    await client.callTool({
      name: "memory_link",
      arguments: { projectID, sourceID: first, targetID: second, predicate: "ABOUT" },
    });
    const repeatedLink = parseTextResult(
      await client.callTool({
        name: "memory_link",
        arguments: { projectID, sourceID: first, targetID: second, predicate: "ABOUT" },
      }),
    );
    expect(repeatedLink.results[0].ok).toBe(true);
    await client.callTool({
      name: "memory_pin",
      arguments: { projectID, id: first, pinned: true },
    });

    const invalidPhrase = await client.callTool({
      name: "project_delete",
      arguments: { projectID, confirmProjectName: "Disposable", confirmation: "DELETE" },
    });
    expect(invalidPhrase.isError).toBe(true);

    const wrongName = parseErrorResult(
      await client.callTool({
        name: "project_delete",
        arguments: {
          projectID,
          confirmProjectName: "Wrong",
          confirmation: "DELETE_PROJECT_AND_ALL_MEMORY",
        },
      }),
    );
    expect(wrongName.error).toMatchObject({ code: "invalid_request", retryable: false });

    const deleted = parseTextResult(
      await client.callTool({
        name: "project_delete",
        arguments: {
          projectID,
          confirmProjectName: "Disposable",
          confirmation: "DELETE_PROJECT_AND_ALL_MEMORY",
        },
      }),
    );
    expect(deleted.results[0]).toMatchObject({
      ok: true,
      deleted: true,
      projectID,
      deletedCounts: { notes: 2, edges: 1, pinned: 1 },
    });
    const repeated = parseErrorResult(
      await client.callTool({
        name: "project_delete",
        arguments: {
          projectID,
          confirmProjectName: "Disposable",
          confirmation: "DELETE_PROJECT_AND_ALL_MEMORY",
        },
      }),
    );
    expect(repeated.error).toMatchObject({ code: "not_found", retryable: false });
    const listed = parseTextResult(
      await client.callTool({ name: "project_list", arguments: {} }),
    );
    expect(listed.projects).toHaveLength(0);
  });

  test("serves the project tools through the stdio entrypoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agz-memory-stdio-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/index.ts"],
      cwd: process.cwd(),
      env: {
        HOME: process.env.HOME ?? "",
        PATH: process.env.PATH ?? "",
        OPENCODE_MEMORY_DATABASE_PATH: join(directory, "memory.sqlite"),
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    cleanups.push(async () => {
      await client.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(9);
    const created = parseTextResult(
      await client.callTool({ name: "project_create", arguments: { projectName: "stdio" } }),
    );
    expect(created.results[0].ok).toBe(true);
  });
});
