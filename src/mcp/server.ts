#!/usr/bin/env node
/**
 * Consistorium MCP server — stdio transport entrypoint.
 *
 * The portable core lives in ./app.ts and is shared with Streamable HTTP.
 */
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap, createMcpServer } from "./app.js";

export interface StdioServerOptions {
  allowWrites?: boolean;
}

async function main(options: StdioServerOptions = {}) {
  const allowWrites = options.allowWrites !== false;
  const runtime = bootstrap({ allowWrites });
  const server = createMcpServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[consistorium] MCP stdio server running. Config: ${runtime.config.configPath} Projects: ${runtime.config.projects.length} Writes: ${allowWrites ? "on" : "off"}`
  );
}

const invokedAsStdioEntry =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsStdioEntry || process.env.CONSISTORIUM_FORCE_STDIO === "1" || process.env.CONTEXT_BRIDGE_FORCE_STDIO === "1") {
  main().catch((e) => {
    console.error("[consistorium] Fatal:", e);
    process.exit(1);
  });
}

export { main as startStdioServer };
