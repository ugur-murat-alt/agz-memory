import { McpServer } from "@modelcontextprotocol/server";
import { MEMORY_GUIDANCE } from "./context";
import type { MemoryStore } from "./store";
import { registerTools } from "./tools";
import { PRODUCT_VERSION } from "./version";

export const SERVER_NAME = "agz-memory";
export const SERVER_VERSION = PRODUCT_VERSION;

export function createMemoryServer(store: MemoryStore): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: MEMORY_GUIDANCE },
  );
  registerTools(server, store);
  return server;
}
