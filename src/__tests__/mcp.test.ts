import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mkdtemp, cleanup, createGitRepo, commitFile, git } from "./helpers.js";
import { TOOL_DEFS } from "../mcp/tools.js";
import { ContextService } from "../core/context.js";
import { SecurityPolicy } from "../core/security.js";
import type { ResolvedConfig } from "../core/types.js";

describe("MCP tool defs", () => {
  it("exposes 11 tools with valid inputSchemas", () => {
    expect(TOOL_DEFS.length).toBe(11);
    const names = TOOL_DEFS.map((t) => t.name);
    expect(names).toContain("context.list_projects");
    expect(names).toContain("context.project_snapshot");
    expect(names).toContain("context.list_worktrees");
    expect(names).toContain("context.worktree_snapshot");
    expect(names).toContain("context.recent_changes");
    expect(names).toContain("context.compare");
    expect(names).toContain("context.search");
    expect(names).toContain("context.list_context_documents");
    expect(names).toContain("context.read_context_document");
    expect(names).toContain("context.list_agent_sessions");
    expect(names).toContain("context.session_snapshot");

    for (const t of TOOL_DEFS) {
      expect(t.name).toMatch(/^context\./);
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema).toBeDefined();
      expect((t.inputSchema as any).type).toBe("object");
    }
  });

  it("project_snapshot requires project", () => {
    const t = TOOL_DEFS.find((x) => x.name === "context.project_snapshot")!;
    expect((t.inputSchema as any).required).toContain("project");
  });

  it("compare requires project, base, target", () => {
    const t = TOOL_DEFS.find((x) => x.name === "context.compare")!;
    expect((t.inputSchema as any).required).toEqual(expect.arrayContaining(["project", "base", "target"]));
  });
});

describe("ContextService as MCP backend — representative responses", () => {
  let repo: string;
  let real: string;
  let config: ResolvedConfig;

  beforeEach(async () => {
    repo = await createGitRepo();
    real = await fs.promises.realpath(repo);
    await commitFile(repo, "TODO.md", "todo content", "init");
    await fs.promises.mkdir(path.join(repo, "docs"), { recursive: true });
    await fs.promises.writeFile(path.join(repo, "docs", "guide.md"), "# Guide");
    await fs.promises.writeFile(path.join(repo, "src.ts"), "export const x = 42;");

    config = {
      version: 1,
      projects: [{ name: "proj", canonicalPath: real, originalPath: real, contextPatterns: ["TODO.md", "docs/**/*.md"] }],
      sessionArtifacts: { patterns: [] },
      search: { maxResults: 50, maxFileSizeBytes: 512 * 1024 },
      limits: { maxFileSizeBytes: 256 * 1024, maxDiffBytes: 128 * 1024, maxSearchResults: 50 },
      configPath: path.join(real, "config.yaml"),
      observedAt: new Date().toISOString(),
    };
  });

  afterEach(async () => {
    await cleanup(repo);
  });

  it("project_snapshot JSON is serializable and has provenance", async () => {
    const svc = new ContextService(config);
    const snap = await svc.projectSnapshot("proj");
    const json = JSON.stringify(snap);
    expect(json).toBeTruthy();
    const parsed = JSON.parse(json);
    expect(parsed.project.name).toBe("proj");
    expect(parsed.provenance.observedAt).toBeTruthy();
    expect(Array.isArray(parsed.worktrees)).toBe(true);
    expect(Array.isArray(parsed.contextDocuments)).toBe(true);
    expect(parsed.git.branch).toBe("main");
  });

  it("search response is correctly shaped", async () => {
    const svc = new ContextService(config);
    const res = await svc.search("proj", "export");
    expect(res.query).toBe("export");
    expect(Array.isArray(res.results)).toBe(true);
    expect(res.provenance.observedAt).toBeTruthy();
    for (const r of res.results) {
      expect(r.path).toBeTruthy();
      expect(typeof r.line).toBe("number");
      expect(typeof r.column).toBe("number");
      expect(typeof r.preview).toBe("string");
    }
  });

  it("compare response includes mergeBase and truncated flag", async () => {
    await commitFile(repo, "a.txt", "a", "commit a");
    await git(repo, ["branch", "feat"]);
    await commitFile(repo, "b.txt", "b", "commit b on main");
    await git(repo, ["checkout", "feat"]);
    await commitFile(repo, "c.txt", "c", "commit c on feat");
    await git(repo, ["checkout", "main"]);
    const svc = new ContextService(config);
    const cmp = await svc.compare("proj", "main", "feat");
    expect(cmp.base).toBe("main");
    expect(cmp.target).toBe("feat");
    expect(typeof cmp.truncated).toBe("boolean");
    expect(cmp.provenance.observedAt).toBeTruthy();
  });

  it("error for unknown project is structured with code", async () => {
    const svc = new ContextService(config);
    try {
      await svc.projectSnapshot("nope");
      expect.fail("should throw");
    } catch (e) {
      const err = e as Error & { code?: string };
      expect(err.code).toBe("NOT_FOUND");
      expect(err.message).toMatch(/Project not found/);
    }
  });
});
