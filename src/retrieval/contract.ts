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

export interface RetrievalBackend {
  id: string;
  upsert(document: DerivedDocument, signal: AbortSignal): Promise<void>;
  delete(ref: DerivedRef, signal: AbortSignal): Promise<void>;
  purgeProject(projectID: string, signal: AbortSignal): Promise<void>;
  query(
    projectID: string,
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<RankedHit[]>;
  health(signal: AbortSignal): Promise<BackendHealth>;
}
