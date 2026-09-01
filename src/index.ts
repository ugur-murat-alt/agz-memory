#!/usr/bin/env bun

import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { resolveConfig } from "./config";
import { openMemoryDatabase } from "./db";
import { createMemoryServer } from "./server";
import { MemoryStore } from "./store";

function main(): void {
  const { databasePath } = resolveConfig();
  const directory = dirname(databasePath);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

  const opened = openMemoryDatabase(databasePath);
  const store = new MemoryStore(opened.db);
  const handle = serveStdio(() => createMemoryServer(store), {
    onerror: (error) => console.error(`[agz-memory] ${error.message}`),
  });

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await handle.close();
    } finally {
      opened.close();
    }
  };

  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  process.stdin.once("end", () => void close());
}

try {
  main();
} catch (error) {
  console.error(
    `[agz-memory] failed to start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
