#!/usr/bin/env bun

import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { resolveConfig } from "./config";
import { openMemoryDatabase } from "./db";
import { createMemoryServer } from "./server";
import { MemoryStore } from "./store";
import { CaptureStore } from "./store/capture";

function main(): void {
  const { databasePath } = resolveConfig();
  const directory = dirname(databasePath);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

  const opened = openMemoryDatabase(databasePath);
  const store = new MemoryStore(opened.db);
  const capture = new CaptureStore(opened.db);
  capture.runRetentionBacklog();
  const retentionTimer = setInterval(() => {
    try {
      capture.runRetentionBacklog();
    } catch (error) {
      console.error(
        `[agz-memory] retention failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, 60 * 60_000);
  retentionTimer.unref();
  const handle = serveStdio(() => createMemoryServer(store), {
    onerror: (error) => console.error(`[agz-memory] ${error.message}`),
  });

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(retentionTimer);
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
