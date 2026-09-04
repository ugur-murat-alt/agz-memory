import { KINDS, type Kind } from "../types";

export interface CreateMutation {
  operation: "create";
  kind: Kind;
  title: string;
  summary: string;
  content?: string;
}

export interface PatchMutation {
  operation: "patch";
  id: string;
  changes: Partial<Pick<CreateMutation, "kind" | "title" | "summary" | "content">>;
}

export interface DeleteMutation {
  operation: "delete";
  id: string;
  confirmation?: string;
}

export type MutationOperation = CreateMutation | PatchMutation | DeleteMutation;

export interface LegacyMutation {
  id?: string;
  kind?: string;
  title?: string;
  summary?: string;
  content?: string;
  delete?: boolean;
  confirmation?: string;
}

export function normalizeLegacyMutation(input: LegacyMutation): MutationOperation {
  const { id, delete: deleteFlag, confirmation, kind, title, summary, content } = input;
  const hasEdits = kind !== undefined || title !== undefined || summary !== undefined || content !== undefined;
  if (deleteFlag) {
    if (!id) throw new TypeError("id is required for delete");
    if (hasEdits) throw new TypeError("cannot combine delete with edits");
    return { operation: "delete", id, confirmation };
  }
  if (id) {
    if (!hasEdits) throw new TypeError("patch requires changes");
    return { operation: "patch", id, changes: { kind: kind as Kind | undefined, title, summary, content } };
  }
  if (!kind || title === undefined || summary === undefined) {
    throw new TypeError("create requires kind, title, and summary");
  }
  return { operation: "create", kind: kind as Kind, title, summary, content };
}

export function isMutationOperation(value: unknown): value is MutationOperation {
  try {
    assertStrictMutationOperation(value);
    return true;
  } catch {
    return false;
  }
}

export function assertStrictMutationOperation(value: unknown): asserts value is MutationOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid mutation");
  const input = value as Record<string, unknown>;
  if (input.operation !== "create" && input.operation !== "patch" && input.operation !== "delete") {
    throw new TypeError("invalid mutation operation");
  }
  const operation = input.operation as MutationOperation["operation"];
  const allowed: Record<MutationOperation["operation"], readonly string[]> = {
    create: ["operation", "kind", "title", "summary", "content"],
    patch: ["operation", "id", "changes"],
    delete: ["operation", "id", "confirmation"],
  };
  const invalid = Object.keys(input).some((key) => !allowed[operation].includes(key));
  if (invalid) throw new TypeError("invalid mutation keys");
  if (input.operation === "create") {
    if (!(KINDS as readonly unknown[]).includes(input.kind) || typeof input.title !== "string" || typeof input.summary !== "string") {
      throw new TypeError("invalid create mutation");
    }
    if (input.content !== undefined && typeof input.content !== "string") throw new TypeError("invalid create mutation");
  }
  if (input.operation === "patch") {
    if (typeof input.id !== "string" || !input.id || !input.changes || typeof input.changes !== "object" || Array.isArray(input.changes)) {
      throw new TypeError("patch requires changes");
    }
    const changes = input.changes as Record<string, unknown>;
    if (Object.values(changes).every((value) => value === undefined)) throw new TypeError("patch requires changes");
    if (Object.keys(changes).some((key) => !["kind", "title", "summary", "content"].includes(key))) throw new TypeError("invalid patch changes");
    if (changes.kind !== undefined && !(KINDS as readonly unknown[]).includes(changes.kind)) throw new TypeError("invalid patch changes");
    for (const key of ["title", "summary", "content"] as const) {
      if (changes[key] !== undefined && typeof changes[key] !== "string") throw new TypeError("invalid patch changes");
    }
  }
  if (input.operation === "delete") {
    if (typeof input.id !== "string" || !input.id) throw new TypeError("id is required for delete");
    if (input.confirmation !== undefined && typeof input.confirmation !== "string") throw new TypeError("invalid delete confirmation");
  }
}
