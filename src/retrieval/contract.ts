export interface RetrievalRequest {
  projectID: string;
  query: string;
  limit: number;
  deadlineAt: number;
  semantic: "off" | "shadow" | "on";
}

export interface RankedHit {
  noteID: string;
  channel: "lexical" | "semantic" | "graph";
  rank: number;
  score?: number;
  revision?: number;
  contentHash?: string;
}

export interface DerivedDocument {
  projectID: string;
  noteID: string;
  revision: number;
  kind: string;
  title: string;
  summary: string;
  content: string;
  contentHash: string;
}

export interface DerivedRef {
  projectID: string;
  noteID: string;
}

export interface BackendHealth {
  ok: boolean;
  version?: string;
  errorCode?: string;
}

export interface BackendOperationContext {
  operationKey: string;
  sequence: number;
  fence: number;
}

export interface OutboxBackend extends RetrievalBackend {
  readonly outboxProtocol: "agz-memory-outbox/1";
  upsert(
    document: DerivedDocument,
    signal: AbortSignal,
    operation: BackendOperationContext,
  ): Promise<void>;
  delete(
    ref: DerivedRef,
    signal: AbortSignal,
    operation: BackendOperationContext,
  ): Promise<void>;
  purgeProject(
    projectID: string,
    signal: AbortSignal,
    operation: BackendOperationContext,
  ): Promise<void>;
}

export interface RetrievalBackend {
  id: string;
  upsert(
    document: DerivedDocument,
    signal: AbortSignal,
    operation?: BackendOperationContext,
  ): Promise<void>;
  delete(
    ref: DerivedRef,
    signal: AbortSignal,
    operation?: BackendOperationContext,
  ): Promise<void>;
  purgeProject(
    projectID: string,
    signal: AbortSignal,
    operation?: BackendOperationContext,
  ): Promise<void>;
  query(
    projectID: string,
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<RankedHit[]>;
  health(signal: AbortSignal): Promise<BackendHealth>;
}

const RANKED_HIT_KEYS = new Set([
  "noteID",
  "channel",
  "rank",
  "score",
  "revision",
  "contentHash",
]);

export function validateBackendHits(value: unknown): value is RankedHit[] {
  if (!Array.isArray(value) || value.length > 1_000) return false;
  try {
    return value.every((hit) => {
      if (hit === null || typeof hit !== "object" || Array.isArray(hit)) return false;
      const record = hit as Record<string, unknown>;
      if (Object.keys(record).some((key) => !RANKED_HIT_KEYS.has(key))) return false;
      if (typeof record.noteID !== "string" || record.noteID.length === 0) return false;
      if (record.channel !== "lexical" && record.channel !== "semantic" && record.channel !== "graph") {
        return false;
      }
      if (!Number.isSafeInteger(record.rank) || (record.rank as number) < 1) return false;
      if (record.score !== undefined && (typeof record.score !== "number" || !Number.isFinite(record.score))) {
        return false;
      }
      if (
        record.revision !== undefined &&
        (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1)
      ) {
        return false;
      }
      if (record.contentHash !== undefined && (typeof record.contentHash !== "string" || !/^[0-9a-f]{64}$/i.test(record.contentHash))) {
        return false;
      }
      return true;
    });
  } catch {
    return false;
  }
}
