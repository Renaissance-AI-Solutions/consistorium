import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const command = process.env.CONSISTORIUM_BIN;
if (!command) {
  throw new Error("CONSISTORIUM_BIN must point to the packed Consistorium CLI");
}

const transport = new StdioClientTransport({
  command,
  args: ["serve", "--read-only"],
});
const client = new Client({ name: "consistorium-package-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);

  if (!names.includes("context_project_briefing")) {
    throw new Error("packed CLI did not expose context_project_briefing");
  }
  if (names.includes("context_task_upsert") || names.includes("context_handoff_create")) {
    throw new Error("packed CLI exposed write tools in --read-only mode");
  }

  console.log(`read-only MCP smoke: ${names.length} tools, write tools hidden`);
} finally {
  await client.close();
}
