import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { MAX_PROJECT_NAME_LENGTH } from "./project";
import type { MemoryStore, ProjectSelector, UpdateInput } from "./store";
import { KINDS, PREDICATES } from "./types";

const MAX_BATCH = 10;
const CLOSED_WORLD = { openWorldHint: false } as const;
const projectID = z.uuid().describe("The immutable project UUID returned by project_create or project_list.");
const projectNameValue = z
  .string()
  .min(1)
  .max(MAX_PROJECT_NAME_LENGTH);
const projectName = projectNameValue.describe(
  "The project's unique current name used to select it. Prefer projectID for long-lived references.",
);
const newProjectName = projectNameValue.describe(
  "Unique name for the new durable workspace or product memory project.",
);
const replacementProjectName = projectNameValue.describe(
  "New unique name for the selected project. The projectID remains unchanged.",
);
const noteID = z.string().describe("A note ID returned by memory_update, memory_recall, or memory_read.");
const kind = z.enum(KINDS).describe("The durable information category for this note.");
const title = z.string().describe("Short, specific title for identifying the durable record.");
const summary = z.string().describe("Concise retrieval summary of the durable record.");
const content = z
  .string()
  .describe("Full durable content. For a new note, the summary is used when content is omitted.");
const query = z.string().describe("Search terms for durable records in the selected project.");

const createUpdateSchema = z
  .object({
    kind,
    title,
    summary,
    content: content.optional(),
  })
  .strict();

const patchUpdateSchema = z
  .object({
    id: noteID,
    kind: kind.optional(),
    title: title.optional(),
    summary: summary.optional(),
    content: content.optional(),
    delete: z
      .boolean()
      .describe("Set true to permanently delete this note; false or omitted performs a patch.")
      .optional(),
  })
  .strict();

const updateSchema = z.union([createUpdateSchema, patchUpdateSchema]);
const linkSchema = z
  .object({
    sourceID: noteID.describe("Subject/source note of the directed relationship."),
    targetID: noteID.describe("Object/target note of the directed relationship."),
    predicate: z
      .enum(PREDICATES)
      .describe(
        "Read as sourceID PREDICATE targetID: A SUPPORTS B; A DERIVED_FROM B; A PART_OF B; A ABOUT B; A PRECEDES B; A SUPERSEDES B.",
      ),
  })
  .strict();

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function resolveProject(store: MemoryStore, selector: ProjectSelector) {
  const resolved = store.resolveProject(selector);
  return resolved.project
    ? { project: resolved.project }
    : { error: { ok: false, reason: resolved.reason ?? "project not found" } };
}

export function registerTools(server: McpServer, store: MemoryStore): void {
  server.registerTool(
    "project_list",
    {
      title: "List memory projects",
      description:
        "List all memory projects with their immutable IDs, current names, note counts, and pinned-note counts. Use this before selecting or creating a project; reuse one only when it represents the same durable workspace.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...CLOSED_WORLD },
    },
    async () => textResult({ projects: store.listProjects() }),
  );

  server.registerTool(
    "project_create",
    {
      title: "Create a memory project",
      description:
        "Create an empty memory project only after project_list confirms that no existing project represents the same durable workspace. The returned projectID is immutable; the unique project name may be changed later.",
      inputSchema: z.object({ projectName: newProjectName }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, ...CLOSED_WORLD },
    },
    async ({ projectName }) => textResult({ results: [store.createProject(projectName)] }),
  );

  server.registerTool(
    "project_update",
    {
      title: "Rename a memory project",
      description:
        "Rename one project by its immutable projectID. Renaming does not change the ID or detach any notes.",
      inputSchema: z.object({ projectID, projectName: replacementProjectName }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, ...CLOSED_WORLD },
    },
    async ({ projectID, projectName }) =>
      textResult({ results: [store.updateProject(projectID, projectName)] }),
  );

  server.registerTool(
    "project_delete",
    {
      title: "Permanently delete a memory project",
      description:
        "DANGER: Permanently deletes the selected project and every note, pinned note, graph edge, and search record owned by it. This cannot be undone. First call project_list, verify the immutable projectID and current name, then provide both confirmation fields exactly.",
      inputSchema: z
        .object({
          projectID,
          confirmProjectName: projectNameValue.describe(
            "Must exactly match the project's current case-sensitive name. This prevents deletion after an unnoticed rename or wrong-ID selection.",
          ),
          confirmation: z
            .literal("DELETE_PROJECT_AND_ALL_MEMORY")
            .describe("Required destructive-action confirmation phrase."),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, ...CLOSED_WORLD },
    },
    async ({ projectID, confirmProjectName }) =>
      textResult({ results: [store.deleteProject(projectID, confirmProjectName)] }),
  );

  server.registerTool(
    "memory_recall",
    {
      title: "Search project memory",
      description:
        "Search memory only inside one project selected by immutable projectID or unique projectName. Pass one query or up to 10 queries. Indexed cards require memory_read for full content.",
      inputSchema: z.union([
        z.object({ projectID, query }).strict(),
        z
          .object({
            projectID,
            queries: z.array(query).min(1).max(MAX_BATCH).describe("One to 10 independent searches."),
          })
          .strict(),
        z.object({ projectName, query }).strict(),
        z
          .object({
            projectName,
            queries: z.array(query).min(1).max(MAX_BATCH).describe("One to 10 independent searches."),
          })
          .strict(),
      ]),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...CLOSED_WORLD },
    },
    async (raw) => {
      const resolved = resolveProject(store, raw);
      if ("error" in resolved) return textResult({ results: [resolved.error] });
      const queries = "query" in raw ? [raw.query] : raw.queries;
      return textResult({
        project: resolved.project,
        results: queries.map((query) => ({
          query,
          cards: store.recall(resolved.project.projectID, query),
        })),
      });
    },
  );

  server.registerTool(
    "memory_update",
    {
      title: "Create, patch, or delete project memory",
      description:
        "Create or patch notes only inside one selected project. Setting delete:true permanently deletes only the specified note from that project; verify the note ID before using delete. A batch contains up to 10 ordered, non-atomic updates: inspect every result because earlier items remain applied if a later item fails. Do not batch destructive deletes unless partial completion is acceptable. Pin state is changed only through memory_pin.",
      inputSchema: z.union([
        createUpdateSchema.extend({ projectID }),
        patchUpdateSchema.extend({ projectID }),
        z
          .object({
            projectID,
            updates: z
              .array(updateSchema)
              .min(1)
              .max(MAX_BATCH)
              .describe("One to 10 ordered, non-atomic create, patch, or delete operations."),
          })
          .strict(),
        createUpdateSchema.extend({ projectName }),
        patchUpdateSchema.extend({ projectName }),
        z
          .object({
            projectName,
            updates: z
              .array(updateSchema)
              .min(1)
              .max(MAX_BATCH)
              .describe("One to 10 ordered, non-atomic create, patch, or delete operations."),
          })
          .strict(),
      ]),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, ...CLOSED_WORLD },
    },
    async (raw) => {
      const resolved = resolveProject(store, raw);
      if ("error" in resolved) return textResult({ results: [resolved.error] });
      const updates: UpdateInput[] = "updates" in raw ? raw.updates : [raw];
      return textResult({
        project: resolved.project,
        results: updates.map((update) => store.update(resolved.project.projectID, update)),
      });
    },
  );

  server.registerTool(
    "memory_pin",
    {
      title: "Pin or unpin project memory",
      description:
        "Set the pinned state of one active note inside one selected project. pinned:true prioritizes matching recall results; pinned:false removes that priority. This tool never deletes note content.",
      inputSchema: z.union([
        z
          .object({
            projectID,
            id: noteID,
            pinned: z.boolean().describe("True to pin the note; false to unpin it."),
          })
          .strict(),
        z
          .object({
            projectName,
            id: noteID,
            pinned: z.boolean().describe("True to pin the note; false to unpin it."),
          })
          .strict(),
      ]),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, ...CLOSED_WORLD },
    },
    async (raw) => {
      const resolved = resolveProject(store, raw);
      if ("error" in resolved) return textResult({ results: [resolved.error] });
      return textResult({
        project: resolved.project,
        results: [store.pin(resolved.project.projectID, raw.id, raw.pinned)],
      });
    },
  );

  server.registerTool(
    "memory_link",
    {
      title: "Link project memories",
      description: `Create one directed graph edge or up to 10 ordered, non-atomic edge operations between active notes in the same selected project; inspect every result because earlier links remain applied if a later item fails. Read each edge as sourceID PREDICATE targetID. Cross-project links are rejected. Predicates: ${PREDICATES.join(", ")}.`,
      inputSchema: z.union([
        linkSchema.extend({ projectID }),
        z
          .object({
            projectID,
            links: z
              .array(linkSchema)
              .min(1)
              .max(MAX_BATCH)
              .describe("One to 10 ordered, non-atomic directed edges."),
          })
          .strict(),
        linkSchema.extend({ projectName }),
        z
          .object({
            projectName,
            links: z
              .array(linkSchema)
              .min(1)
              .max(MAX_BATCH)
              .describe("One to 10 ordered, non-atomic directed edges."),
          })
          .strict(),
      ]),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, ...CLOSED_WORLD },
    },
    async (raw) => {
      const resolved = resolveProject(store, raw);
      if ("error" in resolved) return textResult({ results: [resolved.error] });
      const links = "links" in raw ? raw.links : [raw];
      return textResult({
        project: resolved.project,
        results: links.map((link) =>
          store.link(resolved.project.projectID, link.sourceID, link.targetID, link.predicate),
        ),
      });
    },
  );

  server.registerTool(
    "memory_read",
    {
      title: "Read project memory",
      description:
        "Read one note or up to 10 notes from one selected project, including full content, pin state, project identity, and same-project graph edges.",
      inputSchema: z.union([
        z.object({ projectID, id: noteID }).strict(),
        z
          .object({
            projectID,
            ids: z.array(noteID).min(1).max(MAX_BATCH).describe("One to 10 note IDs to read."),
          })
          .strict(),
        z.object({ projectName, id: noteID }).strict(),
        z
          .object({
            projectName,
            ids: z.array(noteID).min(1).max(MAX_BATCH).describe("One to 10 note IDs to read."),
          })
          .strict(),
      ]),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...CLOSED_WORLD },
    },
    async (raw) => {
      const resolved = resolveProject(store, raw);
      if ("error" in resolved) return textResult({ results: [resolved.error] });
      const ids = "id" in raw ? [raw.id] : raw.ids;
      return textResult({
        project: resolved.project,
        results: ids.map((id) => ({
          id,
          result: store.read(resolved.project.projectID, id),
        })),
      });
    },
  );
}
