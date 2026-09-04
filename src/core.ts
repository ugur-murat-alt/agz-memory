import type { OutboxBackend, RetrievalBackend } from "./retrieval/contract";
import { openMemoryDatabase, type OpenedDB } from "./db";
import { CaptureStore } from "./store/capture";
import { MemoryStore } from "./store";
import { OutboxWorker } from "./store/outbox";
import { RetrievalStore } from "./store/retrieval";

export interface MemoryCoreOptions {
  indexBackends?: readonly string[];
  retrievalBackend?: RetrievalBackend;
  outboxBackends?: ReadonlyMap<string, OutboxBackend>;
}

export class MemoryCore {
  readonly memory: MemoryStore;
  readonly capture: CaptureStore;
  readonly retrieval: RetrievalStore;
  readonly outbox?: OutboxWorker;

  constructor(
    private opened: OpenedDB,
    options: MemoryCoreOptions = {},
  ) {
    this.memory = new MemoryStore(opened.db, options.indexBackends);
    this.capture = new CaptureStore(opened.db, options.indexBackends);
    this.retrieval = new RetrievalStore(opened.db, options.retrievalBackend);
    if (options.outboxBackends) this.outbox = new OutboxWorker(opened.db, options.outboxBackends);
  }

  close(): void {
    this.opened.close();
  }
}

export function openMemoryCore(databasePath: string, options: MemoryCoreOptions = {}): MemoryCore {
  return new MemoryCore(openMemoryDatabase(databasePath), options);
}

export * from "./capture/contract";
export * from "./capture/identity";
export * from "./capture/policy";
export * from "./capture/projection";
export * from "./capture/redact";
export * from "./retrieval/contract";
export * from "./retrieval/formatter";
export * from "./store/capture";
export * from "./contracts/limits";
export * from "./contracts/mutation";
export * from "./contracts/error";
export * from "./contracts/pagination";
export * from "./types";
export * from "./version";
