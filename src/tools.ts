import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { MAX_PROJECT_NAME_LENGTH } from "./project";
import type { MemoryStore, ProjectSelector } from "./store";
import { KINDS, PREDICATES } from "./types";
import { LIMITS, assertRequestLimit, boundedText } from "./contracts/limits";
import { asBusinessError, businessError, toPublicError } from "./contracts/error";
import { normalizeLegacyMutation } from "./contracts/mutation";

const MAX_BATCH = LIMITS.batch;
const pageLimit = z.number().int().min(1).max(LIMITS.pageSize).optional();
const cursor = z.string().max(2_048).optional();
const snapshot = z.string().max(1_024).optional();
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
const noteID = boundedText("noteID", "A note ID returned by memory_update, memory_recall, or memory_read.");
const kind = z.enum(KINDS).describe("The durable information category for this note.");
const title = boundedText("title", "Short, specific title for identifying the durable record.");
const summary = boundedText("summary", "Concise retrieval summary of the durable record.");
const content = boundedText("content", "Full durable content. For a new note, the summary is used when content is omitted.");
const query = boundedText("query", "Search terms for durable records in the selected project.");

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
  .strict()
  .superRefine((value, context) => {
    const hasEdits = value.kind !== undefined || value.title !== undefined || value.summary !== undefined || value.content !== undefined;
    if (value.delete && hasEdits) context.addIssue({ code: "custom", message: "cannot combine delete with edits" });
    if (!value.delete && !hasEdits) context.addIssue({ code: "custom", message: "patch requires changes" });
  });

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
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text, "utf8") > LIMITS.responseBytes) return errorResult(businessError("limit_exceeded", "response exceeds configured limit"));
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(error: unknown, operation = "tool") {
  const publicError = toPublicError(asBusinessError(error));
  logPublicError(operation, publicError);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: publicError }, null, 2) }], isError: true };
}

function logPublicError(operation: string, publicError: ReturnType<typeof toPublicError>) {
  console.error(JSON.stringify({ component: "mcp", operation, outcome: "error", error_code: publicError.code, correlation_id: publicError.correlationID }));
}

function batchFailure(error: unknown, operation: string) {
  const publicError = toPublicError(asBusinessError(error));
  logPublicError(operation, publicError);
  return { ok: false as const, error: publicError };
}

async function guardTool<T>(operation: string, work: () => T | Promise<T>) {
  try {
    return await work();
  } catch (error) {
    return errorResult(error, operation);
  }
}

function updateFailure(result: { reason?: string }) {
  const reason = result.reason ?? "memory update failed";
  if (reason.includes("not found")) return businessError("not_found", "memory record not found");
  if (reason.includes("conflict") || reason.includes("already exists")) return businessError("conflict", "memory operation conflicted");
  return businessError("invalid_request", "memory operation was rejected");
}

function singleResult(result: { ok?: boolean; reason?: string }, operation: string) {
  if (result.ok !== false) return textResult({ results: [result] });
  const error = updateFailure(result);
  return errorResult(error, operation);
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
       inputSchema: z.object({ limit: pageLimit, cursor, snapshot }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...CLOSED_WORLD },
    },
    async (raw) => guardTool("project_list", async () => {
        const page = store.listProjectsPage(raw.limit ?? LIMITS.pageSize, raw.cursor, raw.snapshot);
        return textResult({ projects: page.items, snapshot: page.snapshot, etag: page.etag, nextCursor: page.nextCursor });
    }),
  );

  server.registerTool(
    "project_create",
    {
      title: "Create a memory project",
      description:
        "Create an empty memory project only after project_list confirms that no existing project represents the same durable workspace. Git linked worktrees share the existing workspace memory project. The returned projectID is immutable; the unique project name may be changed later.",
      inputSchema: z.object({ projectName: newProjectName }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, ...CLOSED_WORLD },
    },
    async ({ projectName }) => guardTool("project_create", () => singleResult(store.createProject(projectName), "project_create")),
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
    async ({ projectID, projectName }) => guardTool("project_update", () => singleResult(store.updateProject(projectID, projectName), "project_update")),
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
    async ({ projectID, confirmProjectName }) => guardTool("project_delete", () => singleResult(store.deleteProject(projectID, confirmProjectName), "project_delete")),
  );

  server.registerTool(
    "memory_recall",
    {
      title: "Search project memory",
      description:
        "Search memory only inside one project selected by immutable projectID or unique projectName. Pass one query or up to 10 queries. Indexed cards require memory_read for full content.",
      inputSchema: z.union([
        z.object({ projectID, query, limit: pageLimit, cursor, snapshot }).strict(),
        z
          .object({
            projectID,
            queries: z.array(query).min(1).max(MAX_BATCH).describe("One to 10 independent searches."),
          })
          .strict(),
        z.object({ projectName, query, limit: pageLimit, cursor, snapshot }).strict(),
        z
          .object({
            projectName,
            queries: z.array(query).min(1).max(MAX_BATCH).describe("One to 10 independent searches."),
          })
          .strict(),
      ]),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...CLOSED_WORLD },
    },
    async (raw) => guardTool("memory_recall", async () => {
      assertRequestLimit(raw);
      const resolved = resolveProject(store, raw);
      if ("error" in resolved) return errorResult(businessError("not_found", "project not found"), "memory_recall");
       const queries = "query" in raw ? [raw.query] : raw.queries;
       return textResult({
         project: resolved.project,
         results: queries.map((query) => ({
           query,
           ...(() => {
              return store.recallPage(
                resolved.project.projectID,
                query,
                (raw as { limit?: number }).limit ?? LIMITS.pageSize,
                (raw as { cursor?: string }).cursor,
                (raw as { snapshot?: string }).snapshot,
              );
           })(),
         })),
      });
    }),
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
    async (raw) => guardTool("memory_update", async () => {
      assertRequestLimit(raw);
      const resolved = resolveProject(store, raw);
      if ("error" in resolved) return errorResult(businessError("not_found", "project not found"), "memory_update");
      const updates = "updates" in raw ? raw.updates : [raw];
      if (updates.length === 1 && !("updates" in raw)) {
        try {
          const result = store.update(resolved.project.projectID, normalizeLegacyMutation(updates[0]!));
          return result.ok
            ? textResult({ project: resolved.project, results: [result] })
            : errorResult(updateFailure(result), "memory_update");
        } catch (error) {
          return errorResult(error, "memory_update");
        }
      }
      const results = updates.map((update) => {
        try {
          const result = store.update(resolved.project.projectID, normalizeLegacyMutation(update));
          return result.ok ? result : batchFailure(updateFailure(result), "memory_update");
        } catch (error) {
          return batchFailure(error, "memory_update");
        }
      });
      return textResult({
        project: resolved.project,
        ...(results.some((result) => !result.ok) ? { status: "partial_failure" } : {}),
        results,
      });
    }),
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
    async (raw) => guardTool("memory_pin", async () => {
      const resolved = resolveProject(store, raw);
      if ("error" in resolved) return errorResult(businessError("not_found", "project not found"), "memory_pin");
      const result = store.pin(resolved.project.projectID, raw.id, raw.pinned);
      return result.ok === false
        ? errorResult(updateFailure(result), "memory_pin")
        : textResult({ project: resolved.project, results: [result] });
    }),
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
    async (raw) => guardTool("memory_link", async () => {
      const resolved = resolveProject(store, raw);
      if ("error" in resolved) return errorResult(businessError("not_found", "project not found"), "memory_link");
      if (!("links" in raw)) {
        try {
          const result = store.link(resolved.project.projectID, raw.sourceID, raw.targetID, raw.predicate);
          return result.ok ? textResult({ project: resolved.project, results: [result] }) : errorResult(updateFailure(result), "memory_link");
        } catch (error) {
          return errorResult(error, "memory_link");
        }
      }
      const results = raw.links.map((link) => {
        try {
          const result = store.link(resolved.project.projectID, link.sourceID, link.targetID, link.predicate);
          return result.ok ? result : batchFailure(updateFailure(result), "memory_link");
        } catch (error) {
          return batchFailure(error, "memory_link");
        }
      });
      return textResult({ project: resolved.project, ...(results.some((result) => !result.ok) ? { status: "partial_failure" } : {}), results });
    }),
  );

  server.registerTool(
    "memory_read",
    {
      title: "Read project memory",
      description:
        "Read one note or up to 10 notes from one selected project, including full content, pin state, project identity, and same-project graph edges.",
      inputSchema: z.union([
         z.object({ projectID, id: noteID, limit: pageLimit, cursor, snapshot }).strict(),
        z
          .object({
            projectID,
            ids: z.array(noteID).min(1).max(MAX_BATCH).describe("One to 10 note IDs to read."),
          })
          .strict(),
         z.object({ projectName, id: noteID, limit: pageLimit, cursor, snapshot }).strict(),
        z
          .object({
            projectName,
            ids: z.array(noteID).min(1).max(MAX_BATCH).describe("One to 10 note IDs to read."),
          })
          .strict(),
      ]),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...CLOSED_WORLD },
    },
    async (raw) => guardTool("memory_read", async () => {
      const resolved = resolveProject(store, raw);
      if ("error" in resolved) return errorResult(businessError("not_found", "project not found"), "memory_read");
      const ids = "id" in raw ? [raw.id] : raw.ids;
      const results = ids.map((id) => ({
        id,
        result: "id" in raw && (raw.limit !== undefined || raw.cursor !== undefined || raw.snapshot !== undefined)
          ? store.readPage(resolved.project.projectID, id, raw.limit ?? LIMITS.pageSize, raw.cursor, raw.snapshot)
          : store.read(resolved.project.projectID, id),
      }));
      const firstResult = results[0]?.result;
      if (!("ids" in raw) && (!firstResult || !("note" in firstResult) || !firstResult.note)) {
        return errorResult(businessError("not_found", "memory record not found"), "memory_read");
      }
      return textResult({
        project: resolved.project,
        results,
      });
    }),
  );
}
