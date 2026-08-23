#!/usr/bin/env node
/**
 * Context Bridge MCP server — stdio transport entrypoint.
 *
 * The portable core lives in ./app.ts and is shared with Streamable HTTP.
 */
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap, createMcpServer } from "./app.js";

async function main() {
  const runtime = bootstrap({ allowWrites: true });
  const server = createMcpServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[context-bridge] MCP stdio server running. Config: ${runtime.config.configPath} Projects: ${runtime.config.projects.length}`
  );
}

const invokedAsStdioEntry =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsStdioEntry || process.env.CONTEXT_BRIDGE_FORCE_STDIO === "1") {
  main().catch((e) => {
    console.error("[context-bridge] Fatal:", e);
    process.exit(1);
  });
}

export { main as startStdioServer };
