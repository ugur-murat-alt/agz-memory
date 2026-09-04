import * as z from "zod/v4";

/** Public payload limits, measured in UTF-8 bytes unless otherwise noted. */
export const LIMITS = {
  title: 240,
  summary: 4_096,
  content: 65_536,
  query: 4_096,
  noteID: 256,
  batch: 10,
  requestBytes: 1_048_576,
  responseBytes: 1_048_576,
  pageSize: 100,
} as const;

export type TextLimit = "title" | "summary" | "content" | "query" | "noteID";

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function assertTextLimit(field: TextLimit, value: string): void {
  const maximum = LIMITS[field];
  if (utf8Bytes(value) > maximum) throw new RangeError(`${field} exceeds ${maximum} UTF-8 bytes`);
}

export function boundedText(field: TextLimit, description: string) {
  return z.string().superRefine((value, context) => {
    if (utf8Bytes(value) > LIMITS[field]) {
      context.addIssue({ code: "custom", message: `${field} exceeds ${LIMITS[field]} UTF-8 bytes` });
    }
  }).describe(description);
}

export function assertRequestLimit(value: unknown): void {
  if (utf8Bytes(JSON.stringify(value)) > LIMITS.requestBytes) {
    throw new RangeError(`request exceeds ${LIMITS.requestBytes} UTF-8 bytes`);
  }
}
