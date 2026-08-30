/**
 * `includeIgnored` / `excludeGlobs` as MCP search arguments.
 *
 * Both default to today's behavior, so an existing caller that sends neither
 * gets exactly the results it got before. `includeIgnored` opts out of the
 * convenience exclusions (build output, minified bundles) only — never out of
 * the security denials, which are enforced independently of this filter.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, cleanup, createGitRepo, commitFile } from "./helpers.js";
import { bootstrap, dispatchTool } from "../mcp/app.js";
import { TOOL_DEFS } from "../mcp/tools.js";
import type { BridgeRuntime } from "../mcp/app.js";
import type { SearchResponse } from "../core/types.js";

function searchSchemaProps(): Record<string, { type?: string; description?: string }> {
  const def = TOOL_DEFS.find((t) => t.name === "context_search")!;
  return (def.inputSchema as { properties: Record<string, { type?: string; description?: string }> }).properties;
}

describe("context_search flag schema", () => {
  it("declares includeIgnored and excludeGlobs", () => {
    const props = searchSchemaProps();
    expect(props.includeIgnored).toBeDefined();
    expect(props.includeIgnored!.type).toBe("boolean");
    expect(props.excludeGlobs).toBeDefined();
    expect(props.excludeGlobs!.type).toBe("array");
  });

  it("keeps both optional so existing callers stay valid", () => {
    const def = TOOL_DEFS.find((t) => t.name === "context_search")!;
    const required = (def.inputSchema as { required?: string[] }).required ?? [];
    expect(required).toEqual(["project", "query"]);
  });

  it("documents that the flags do not relax security exclusions", () => {
    const def = TOOL_DEFS.find((t) => t.name === "context_search")!;
    expect(def.description).toMatch(/secret|security/i);
    expect(searchSchemaProps().includeIgnored!.description).toMatch(/secret|security|denied/i);
  });
});

describe("context_search flag behavior", () => {
  let repo: string;
  let stateDir: string;
  let runtime: BridgeRuntime;

  beforeEach(async () => {
    repo = await createGitRepo();
    stateDir = await mkdtemp("cb-flags-");
    const real = await fs.promises.realpath(repo);

    await commitFile(repo, "README.md", "needle in readme\n", "readme");
    await fs.promises.mkdir(path.join(real, "docs"), { recursive: true });
    await fs.promises.writeFile(path.join(real, "docs", "guide.md"), "needle in guide\n");
    // Excluded by default: build output and minified bundles.
    await fs.promises.mkdir(path.join(real, "dist"), { recursive: true });
    await fs.promises.writeFile(path.join(real, "dist", "out.js"), "needle in dist\n");
    await fs.promises.writeFile(path.join(real, "app.min.js"), "needle in bundle\n");
    // Never returnable: denied by policy, not by the convenience excludes.
    await fs.promises.mkdir(path.join(real, "node_modules", "pkg"), { recursive: true });
    await fs.promises.writeFile(path.join(real, "node_modules", "pkg", "index.js"), "needle in vendor\n");
    await fs.promises.writeFile(path.join(real, "my-secret.md"), "needle in secret\n");
    await fs.promises.writeFile(path.join(real, ".env"), "needle in env\n");

    const configPath = path.join(stateDir, "config.yaml");
    await fs.promises.writeFile(
      configPath,
      `version: 1\nprojects:\n  - name: proj\n    path: ${real}\n    context: ["**/*.md"]\n`,
      "utf8"
    );
    runtime = bootstrap({ configPath, stateDir, allowWrites: false });
  });

  afterEach(async () => {
    await cleanup(repo);
    await cleanup(stateDir);
  });

  async function search(args: Record<string, unknown>): Promise<SearchResponse> {
    const res = await dispatchTool(runtime, "context_search", { project: "proj", query: "needle", ...args });
    expect(res.isError).toBeFalsy();
    return JSON.parse(res.text) as SearchResponse;
  }

  it("defaults to today's behavior when neither flag is sent", async () => {
    const paths = (await search({})).results.map((r) => r.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("docs/guide.md");
    expect(paths).not.toContain("dist/out.js");
    expect(paths).not.toContain("app.min.js");
  });

  it("applies excludeGlobs on top of the default exclusions", async () => {
    const paths = (await search({ excludeGlobs: ["docs/**"] })).results.map((r) => r.path);
    expect(paths).toContain("README.md");
    expect(paths).not.toContain("docs/guide.md");
    expect(paths).not.toContain("dist/out.js");
  });

  it("accepts several excludeGlobs at once", async () => {
    const paths = (await search({ excludeGlobs: ["docs/**", "README.md"] })).results.map((r) => r.path);
    expect(paths).not.toContain("docs/guide.md");
    expect(paths).not.toContain("README.md");
  });

  it("includeIgnored surfaces build output that is otherwise filtered", async () => {
    const paths = (await search({ includeIgnored: true })).results.map((r) => r.path);
    expect(paths).toContain("dist/out.js");
    expect(paths).toContain("app.min.js");
    expect(paths).toContain("README.md");
  });

  it("includeIgnored never surfaces secrets, .env, .git or node_modules", async () => {
    const paths = (await search({ includeIgnored: true, maxResults: 100 })).results.map((r) => r.path);
    expect(paths).not.toContain("my-secret.md");
    expect(paths).not.toContain(".env");
    for (const p of paths) {
      expect(p).not.toMatch(/(^|\/)node_modules\//);
      expect(p).not.toMatch(/(^|\/)\.git\//);
    }
  });

  it("still honours excludeGlobs when includeIgnored is set", async () => {
    const paths = (await search({ includeIgnored: true, excludeGlobs: ["dist/**"] })).results.map((r) => r.path);
    expect(paths).not.toContain("dist/out.js");
    expect(paths).toContain("app.min.js");
  });
});

describe("context_search argument validation", () => {
  let repo: string;
  let stateDir: string;
  let runtime: BridgeRuntime;

  beforeEach(async () => {
    repo = await mkdtemp();
    stateDir = await mkdtemp("cb-flags-val-");
    const real = await fs.promises.realpath(repo);
    await fs.promises.writeFile(path.join(real, "a.md"), "needle\n");
    const configPath = path.join(stateDir, "config.yaml");
    await fs.promises.writeFile(
      configPath,
      `version: 1\nprojects:\n  - name: proj\n    path: ${real}\n    context: ["**/*.md"]\n`,
      "utf8"
    );
    runtime = bootstrap({ configPath, stateDir, allowWrites: false });
  });

  afterEach(async () => {
    await cleanup(repo);
    await cleanup(stateDir);
  });

  /** Invalid arguments are rejected before any filesystem work, as INVALID_ARG. */
  async function expectInvalid(args: Record<string, unknown>): Promise<void> {
    await expect(
      dispatchTool(runtime, "context_search", { project: "proj", query: "needle", ...args })
    ).rejects.toMatchObject({ code: "INVALID_ARG" });
  }

  it("rejects a non-boolean includeIgnored", async () => {
    await expectInvalid({ includeIgnored: "yes" });
    await expectInvalid({ includeIgnored: 1 });
  });

  it("rejects excludeGlobs that is not an array of non-empty strings", async () => {
    await expectInvalid({ excludeGlobs: "docs/**" });
    await expectInvalid({ excludeGlobs: [""] });
    await expectInvalid({ excludeGlobs: [1, 2] });
  });

  it("bounds the number and length of excludeGlobs", async () => {
    await expectInvalid({ excludeGlobs: Array.from({ length: 200 }, (_, i) => `d${i}/**`) });
    await expectInvalid({ excludeGlobs: ["x".repeat(5000)] });
  });

  it("still rejects an out-of-range maxResults", async () => {
    await expectInvalid({ maxResults: 0 });
    await expectInvalid({ maxResults: 10_000 });
  });

  it("still rejects an empty query", async () => {
    await expect(
      dispatchTool(runtime, "context_search", { project: "proj", query: "" })
    ).rejects.toMatchObject({ code: "INVALID_ARG" });
  });
});
