import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mkdtemp, cleanup, createGitRepo, commitFile, git } from "./helpers.js";
import { MCP_SERVER_INSTRUCTIONS, TOOL_DEFS, canonicalToolName } from "../mcp/tools.js";
import { ContextService } from "../core/context.js";
import { SecurityPolicy } from "../core/security.js";
import type { ResolvedConfig } from "../core/types.js";

describe("MCP tool defs", () => {
  it("provides self-contained, vendor-neutral initialize instructions", () => {
    const first512 = MCP_SERVER_INSTRUCTIONS.slice(0, 512);
    expect(first512).toContain("vendor-neutral");
    expect(first512).toContain("passive and read-only");
    expect(first512).toContain("context_project_briefing");
    expect(first512).toContain("context_project_snapshot");
    expect(first512).toContain("context_handoff_list/handoff_get");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("evidence to verify");
    expect(MCP_SERVER_INSTRUCTIONS).not.toMatch(/OpenAI|ChatGPT|Claude|Cursor|Hermes/);
  });

  it("names every tool so OpenAI-style function validation accepts it", () => {
    // OpenAI validates function names against ^[a-zA-Z0-9_-]{1,64}$, which
    // rejects the dotted tool names MCP itself allows.
    for (const t of TOOL_DEFS) {
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it("still dispatches the pre-0.3 dotted tool names", () => {
    for (const t of TOOL_DEFS) {
      const legacy = t.name.replace(/^context_/, "context.");
      expect(canonicalToolName(legacy)).toBe(t.name);
    }
    expect(canonicalToolName("context_project_briefing")).toBe("context_project_briefing");
    expect(canonicalToolName("nonsense")).toBe("nonsense");
  });

  it("ships a portable node-based Agent Plugins STDIO entry", async () => {
    const manifest = JSON.parse(
      await fs.promises.readFile(path.resolve("mcp.json"), "utf8")
    ) as { mcpServers: Record<string, { type: string; command: string; args: string[]; cwd: string }> };
    const entry = manifest.mcpServers["consistorium"];
    expect(entry).toEqual({
      type: "stdio",
      command: "node",
      args: ["./dist/mcp/server.js"],
      cwd: "${PLUGIN_ROOT}",
    });
  });

  it("exposes continuity and observability tools with valid inputSchemas", () => {
    expect(TOOL_DEFS.length).toBe(18);
    const names = TOOL_DEFS.map((t) => t.name);
    expect(names).toContain("context_list_projects");
    expect(names).toContain("context_project_briefing");
    expect(names).toContain("context_project_snapshot");
    expect(names).toContain("context_list_worktrees");
    expect(names).toContain("context_worktree_snapshot");
    expect(names).toContain("context_recent_changes");
    expect(names).toContain("context_compare");
    expect(names).toContain("context_search");
    expect(names).toContain("context_list_context_documents");
    expect(names).toContain("context_read_context_document");
    expect(names).toContain("context_list_agent_sessions");
    expect(names).toContain("context_session_snapshot");
    expect(names).toContain("context_task_upsert");
    expect(names).toContain("context_task_list");
    expect(names).toContain("context_task_get");
    expect(names).toContain("context_handoff_create");
    expect(names).toContain("context_handoff_list");
    expect(names).toContain("context_handoff_get");

    for (const t of TOOL_DEFS) {
      expect(t.name).toMatch(/^context_/);
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema).toBeDefined();
      expect((t.inputSchema as any).type).toBe("object");
      expect(t.annotations).toBeDefined();
      expect(typeof t.annotations.readOnlyHint).toBe("boolean");
    }
    expect(TOOL_DEFS.find((t) => t.name === "context_task_upsert")!.annotations.readOnlyHint).toBe(false);
    expect(TOOL_DEFS.find((t) => t.name === "context_project_briefing")!.annotations.readOnlyHint).toBe(true);
  });

  it("project_snapshot requires project", () => {
    const t = TOOL_DEFS.find((x) => x.name === "context_project_snapshot")!;
    expect((t.inputSchema as any).required).toContain("project");
  });

  it("compare requires project, base, target", () => {
    const t = TOOL_DEFS.find((x) => x.name === "context_compare")!;
    expect((t.inputSchema as any).required).toEqual(expect.arrayContaining(["project", "base", "target"]));
  });

  it("handoff creation requires a task, status, and summary", () => {
    const t = TOOL_DEFS.find((x) => x.name === "context_handoff_create")!;
    expect((t.inputSchema as any).required).toEqual(expect.arrayContaining(["project", "taskId", "status", "summary"]));
    expect((t.inputSchema as any).properties.assertedRepositoryState.properties.isDirty.type).toBe("boolean");
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
