import { createHash } from "crypto";

export function hashRoot(directory: string): string {
  return createHash("sha256").update(directory).digest("hex");
}
