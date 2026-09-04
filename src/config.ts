import { homedir } from "os";
import { join } from "path";

export interface MemoryConfig {
  databasePath: string;
  quarantineKeyringPath: string;
}

export function resolveConfig(environment: NodeJS.ProcessEnv = process.env): MemoryConfig {
  const databasePath =
    environment.OPENCODE_MEMORY_DATABASE_PATH?.trim() ||
    join(environment.HOME ?? homedir(), ".local", "share", "opencode-memory", "memory.sqlite");
  const quarantineKeyringPath =
    environment.OPENCODE_MEMORY_QUARANTINE_KEYRING_PATH?.trim() ||
    `${databasePath}.quarantine-keys`;
  return { databasePath, quarantineKeyringPath };
}
