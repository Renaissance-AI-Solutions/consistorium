import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPluginManifests } from "../cli/manifests.js";
import { cleanup, mkdtemp } from "./helpers.js";

const plugin = { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "example" };
const mcp = { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} };
let root: string;
beforeEach(async () => {
  root = await mkdtemp("cb-manifests-");
  await write("plugin.json", plugin);
  await write("mcp.json", mcp);
});
afterEach(async () => { await cleanup(root); });
async function write(file: string, value: unknown) {
  await fs.writeFile(path.join(root, file), JSON.stringify(value));
}
function errors(file: string) {
  return checkPluginManifests(root).find((check) => check.file === file)!.errors;
}

describe("doctor manifest checks", () => {
  it("validates the shipped manifests and minimal schema-valid manifests", () => {
    expect(checkPluginManifests(fileURLToPath(new URL("../../", import.meta.url))).every((check) => !check.errors.length)).toBe(true);
    expect(checkPluginManifests(root).every((check) => !check.errors.length)).toBe(true);
  });

  it("accepts optional metadata, extension objects, and every supported transport", async () => {
    await write("plugin.json", { ...plugin, version: "1.0.0", description: "Example", author: { name: "Author", email: "a@example.org", url: "https://example.org" }, homepage: "https://example.org", repository: "https://example.org/repo", license: "MIT", keywords: ["mcp"], extensions: { "org.example": { nested: [1, true] } } });
    await write("mcp.json", { ...mcp, mcpServers: {
      local: { type: "stdio", command: "node", args: ["index.js"], env: { EXAMPLE: "value" }, cwd: "${PLUGIN_ROOT}" },
      http: { type: "streamable-http", url: "https://example.org/mcp", headers: { Authorization: "${AUTH}" } },
      legacy: { type: "sse", url: "https://example.org/sse" },
    } });
    expect(checkPluginManifests(root).every((check) => !check.errors.length)).toBe(true);
    for (const cwd of ["./server", "${PLUGIN_DATA}/state", "${PLUGIN_ROOT}/server"]) {
      await write("mcp.json", { ...mcp, mcpServers: { local: { type: "stdio", command: "node", cwd } } });
      expect(errors("mcp.json")).toEqual([]);
    }
  });

  it.each([
    null, [], {}, { ...plugin, $schema: "unknown" }, { ...plugin, typo: true },
    ...["", "Upper", "a--b", "a..b", "-bad", "bad-", "a".repeat(65)].map((name) => ({ ...plugin, name })),
    { ...plugin, version: 4 }, { ...plugin, author: "name" },
    { ...plugin, author: { unknown: true } }, { ...plugin, keywords: [1] },
    { ...plugin, extensions: { "org.example": [] } },
  ])("rejects malformed plugin metadata %#", async (value) => {
    await write("plugin.json", value);
    expect(errors("plugin.json").length).toBeGreaterThan(0);
  });

  it.each([
    null, [], {}, { type: "unknown" }, { type: "stdio" }, { type: "stdio", command: "" },
    { type: "stdio", command: 4 }, { type: "stdio", command: "node", args: [1] },
    { type: "stdio", command: "node", env: { KEY: 42 } },
    { type: "stdio", command: "node", env: { PLUGIN_ROOT: "override" } },
    { type: "stdio", command: "node", env: { PLUGIN_DATA: "override" } },
    ...["/tmp", "../escape", "${PLUGIN_ROOT_SUFFIX}", "${PLUGIN_DATA}suffix"].map((cwd) => ({ type: "stdio", command: "node", cwd })),
    { type: "stdio", command: "node", url: "https://example.org" },
    { type: "streamable-http" }, { type: "streamable-http", url: "" },
    { type: "sse", url: 1 }, { type: "sse", url: "https://example.org", headers: { auth: 1 } },
    { type: "streamable-http", url: "https://example.org", command: "node" },
  ])("rejects malformed or mixed transport fields %#", async (server) => {
    await write("mcp.json", { ...mcp, mcpServers: { example: server } });
    expect(errors("mcp.json").length).toBeGreaterThan(0);
  });

  it.each([null, [], {}, { ...mcp, $schema: "unknown" }, { ...mcp, extra: true }, { ...mcp, mcpServers: [] }])("rejects malformed MCP roots %#", async (value) => {
    await write("mcp.json", value);
    expect(errors("mcp.json").length).toBeGreaterThan(0);
  });

  it("reports both files and JSON/read failures without disclosing contents", async () => {
    await fs.writeFile(path.join(root, "plugin.json"), '{"private":"sensitive-value",');
    await fs.unlink(path.join(root, "mcp.json"));
    const checks = checkPluginManifests(root);
    expect(checks[0]!.errors).toEqual(["Invalid JSON"]);
    expect(checks[1]!.errors).toEqual(["Cannot read file (ENOENT)"]);
    expect(JSON.stringify(checks)).not.toContain("sensitive-value");
    await write("mcp.json", { ...mcp, mcpServers: { example: { type: "sensitive-value" } } });
    expect(JSON.stringify(errors("mcp.json"))).not.toContain("sensitive-value");
    expect(errors("mcp.json")[0]).toContain("mcpServers.example.type");
  });
});
