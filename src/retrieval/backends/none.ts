import type {
  BackendHealth,
  DerivedDocument,
  DerivedRef,
  RankedHit,
  RetrievalBackend,
} from "../contract";

export class NoneBackend implements RetrievalBackend {
  readonly id = "none";

  async upsert(_document: DerivedDocument, _signal: AbortSignal): Promise<void> {}
  async delete(_ref: DerivedRef, _signal: AbortSignal): Promise<void> {}
  async purgeProject(_projectID: string, _signal: AbortSignal): Promise<void> {}
  async query(
    _projectID: string,
    _query: string,
    _limit: number,
    _signal: AbortSignal,
  ): Promise<RankedHit[]> {
    return [];
  }
  async health(_signal: AbortSignal): Promise<BackendHealth> {
    return { ok: true, version: "none" };
  }
}
