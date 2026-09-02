import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const [serverPath, databasePath, expectedVersion] = process.argv.slice(2);
if (!serverPath || !databasePath || !expectedVersion) {
  throw new Error("usage: verify-packed-mcp.ts <server-path> <database-path> <version>");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: {
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
    OPENCODE_MEMORY_DATABASE_PATH: databasePath,
  },
  stderr: "pipe",
});
const client = new Client({ name: "packed-smoke", version: "1" });

try {
  await client.connect(transport);
  const identity = client.getServerVersion();
  if (identity?.name !== "agz-memory" || identity.version !== expectedVersion) {
    throw new Error(`unexpected MCP identity: ${JSON.stringify(identity)}`);
  }
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  const expected = [
    "memory_link",
    "memory_pin",
    "memory_read",
    "memory_recall",
    "memory_update",
    "project_create",
    "project_delete",
    "project_list",
    "project_update",
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`unexpected MCP tool catalog: ${JSON.stringify(names)}`);
  }
  const result = await client.callTool({ name: "project_list", arguments: {} });
  if (result.isError) throw new Error("packaged project_list failed");
} finally {
  await client.close();
}
