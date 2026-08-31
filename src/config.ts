import { homedir } from "os";
import { join } from "path";

export interface MemoryConfig {
  databasePath: string;
}

export function resolveConfig(environment: NodeJS.ProcessEnv = process.env): MemoryConfig {
  const databasePath =
    environment.OPENCODE_MEMORY_DATABASE_PATH?.trim() ||
    join(environment.HOME ?? homedir(), ".local", "share", "opencode-memory", "memory.sqlite");
  return { databasePath };
}
