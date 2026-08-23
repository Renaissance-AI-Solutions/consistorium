import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bootstrap } from "../mcp/app.js";
import { startHttpServer, validateHttpOptions, tokensEqual, extractBearer } from "../mcp/http.js";
import type { StartedHttpServer } from "../mcp/http.js";
import { cleanup, commitFile, createGitRepo, mkdtemp } from "./helpers.js";

const disposables: string[] = [];
const servers: StartedHttpServer[] = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (disposables.length) await cleanup(disposables.pop()!);
});

async function writeConfig(repo: string, stateDir: string): Promise<string> {
  const configPath = path.join(stateDir, "config.yaml");
  const real = await fs.promises.realpath(repo);
  await fs.promises.writeFile(
    configPath,
    `version: 1\nprojects:\n  - name: corpus\n    path: ${real}\n    context:\n      - README.md\n      - TODO.md\n`,
    "utf8"
  );
  return configPath;
}

describe("HTTP security", () => {
  it("refuses anonymous non-loopback binds", () => {
    expect(() => validateHttpOptions({ host: "0.0.0.0", allowAnonymous: true })).toThrow(/allow-anonymous/);
    expect(() => validateHttpOptions({ host: "0.0.0.0" })).toThrow(/non-loopback/);
    expect(() => validateHttpOptions({ host: "127.0.0.1", allowAnonymous: true })).not.toThrow();
  });

  it("compares bearer tokens in constant time and parses Authorization", () => {
    const token = "abc123tokenvalue________";
    expect(tokensEqual(token, token)).toBe(true);
    expect(tokensEqual(token, "nope")).toBe(false);
    expect(extractBearer("Bearer secret")).toBe("secret");
    expect(extractBearer("Basic x")).toBeUndefined();
  });

  it("rejects HTTP requests without the configured bearer token", async () => {
    const repo = await createGitRepo();
    const stateDir = await mkdtemp("cb-http-auth-");
    disposables.push(repo, stateDir);
    await commitFile(repo, "README.md", "# Corpus\n\nPrivate repo.\n", "readme");
    const configPath = await writeConfig(repo, stateDir);
    const runtime = bootstrap({ configPath, stateDir, allowWrites: false });
    const started = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token-value-0123456789",
      runtime,
    });
    servers.push(started);

    const unauth = await fetch(started.url.replace(/\/mcp$/, "/healthz"));
    expect(unauth.status).toBe(200);

    const denied = await fetch(started.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(denied.status).toBe(401);
  });

  it("hides write tools on the default read-only HTTP transport", async () => {
    const repo = await createGitRepo();
    const stateDir = await mkdtemp("cb-http-ro-");
    disposables.push(repo, stateDir);
    await commitFile(repo, "README.md", "# Corpus\n\nPrivate repo.\n", "readme");
    const configPath = await writeConfig(repo, stateDir);
    const runtime = bootstrap({ configPath, stateDir, allowWrites: false });
    const token = "read-only-token-0123456789abcd";
    const started = await startHttpServer({ host: "127.0.0.1", port: 0, token, runtime, allowWrites: false });
    servers.push(started);

    const transport = new StreamableHTTPClientTransport(new URL(started.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "http-test", version: "0.2.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain("context_project_briefing");
    expect(names).not.toContain("context_task_upsert");
    expect(names).not.toContain("context_handoff_create");
    await client.close();
    await transport.close();
  });
});
