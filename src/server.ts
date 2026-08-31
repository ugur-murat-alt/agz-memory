import { McpServer } from "@modelcontextprotocol/server";
import { MEMORY_GUIDANCE } from "./context";
import type { MemoryStore } from "./store";
import { registerTools } from "./tools";

export const SERVER_NAME = "opencode2-memory";
export const SERVER_VERSION = "0.3.0";

export function createMemoryServer(store: MemoryStore): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: MEMORY_GUIDANCE },
  );
  registerTools(server, store);
  return server;
}
