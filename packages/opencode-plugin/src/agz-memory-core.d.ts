type CoreModule = typeof import("../../../dist/types/core");

declare module "@vaur94/agz-memory/core" {
  export const CAPTURE_SCHEMA: CoreModule["CAPTURE_SCHEMA"];
  export const REDACTION_POLICY_VERSION: CoreModule["REDACTION_POLICY_VERSION"];
  export const SUPPORTED_OPENCODE_VERSION: CoreModule["SUPPORTED_OPENCODE_VERSION"];
  export const captureIdempotencyKey: CoreModule["captureIdempotencyKey"];
  export const extractExplicitUserCandidate: CoreModule["extractExplicitUserCandidate"];
  export const formatUntrustedContext: CoreModule["formatUntrustedContext"];
  export const openMemoryCore: CoreModule["openMemoryCore"];
  export const projectAssistantParts: CoreModule["projectAssistantParts"];
  export const projectToolSignal: CoreModule["projectToolSignal"];
  export const redactText: CoreModule["redactText"];
  export type CaptureEventV1 = import("../../../dist/types/core").CaptureEventV1;
  export type MemoryCandidateV1 = import("../../../dist/types/core").MemoryCandidateV1;
  export type MemoryCore = import("../../../dist/types/core").MemoryCore;
}
