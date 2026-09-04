export type BusinessErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "limit_exceeded"
  | "invalid_cursor"
  | "cursor_scope_mismatch"
  | "stale_cursor"
  | "internal_error";

export class MemoryBusinessError extends Error {
  constructor(
    readonly code: BusinessErrorCode,
    message: string,
    readonly correlationID = newCorrelationID(),
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export function correlationID(): string {
  return newCorrelationID();
}

function newCorrelationID(): string {
  return crypto.randomUUID();
}

export function businessError(
  code: BusinessErrorCode,
  message: string,
  id = correlationID(),
  cause?: unknown,
): MemoryBusinessError {
  return new MemoryBusinessError(code, message, id, cause);
}

export function toPublicError(error: MemoryBusinessError): {
  code: BusinessErrorCode;
  correlationID: string;
  retryable: boolean;
  message: string;
} {
  return { code: error.code, correlationID: error.correlationID, retryable: error.code === "internal_error", message: error.message };
}

export function asBusinessError(error: unknown, id = correlationID()): MemoryBusinessError {
  if (error instanceof MemoryBusinessError) return error;
  if (error instanceof RangeError) return businessError("limit_exceeded", error.message, id, error);
  if (error instanceof TypeError) {
    if (error.message === "invalid_cursor") return businessError("invalid_cursor", "cursor is invalid", id, error);
    if (error.message === "cursor_scope_mismatch") return businessError("cursor_scope_mismatch", "cursor does not match this request", id, error);
    if (error.message === "stale_snapshot") return businessError("stale_cursor", "cursor snapshot is stale", id, error);
    return businessError("invalid_request", "request is invalid", id, error);
  }
  return businessError("internal_error", "memory operation failed", id, error);
}
