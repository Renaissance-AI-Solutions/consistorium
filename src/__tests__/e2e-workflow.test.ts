/**
 * End-to-end product claim:
 *   Agent A records work through Consistorium.
 *   Fresh Agent B reconstructs that work from project identity alone.
 *   A fresh ChatGPT-compatible Streamable HTTP client asks strategic questions
 *   with no conversational memory.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ContextService } from "../core/context.js";
import { ContinuityStore } from "../core/continuity.js";
import { buildProjectBriefing } from "../core/briefing.js";
import { bootstrap, dispatchTool } from "../mcp/app.js";
import { startHttpServer } from "../mcp/http.js";
import type { StartedHttpServer } from "../mcp/http.js";
import type { ResolvedConfig } from "../core/types.js";
import { cleanup, commitFile, createGitRepo, git, mkdtemp } from "./helpers.js";

const disposables: string[] = [];
const servers: StartedHttpServer[] = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (disposables.length) await cleanup(disposables.pop()!);
});

function configFor(repo: string, stateDir: string): ResolvedConfig {
  return {
    version: 1,
    projects: [{
      name: "corpus",
      canonicalPath: repo,
      originalPath: repo,
      contextPatterns: ["README.md", "DESIGN.md", "TODO.md"],
    }],
    sessionArtifacts: { patterns: [] },
    search: { maxResults: 50, maxFileSizeBytes: 512 * 1024 },
    limits: { maxFileSizeBytes: 256 * 1024, maxDiffBytes: 128 * 1024, maxSearchResults: 50, maxWorktrees: 50 },
    configPath: path.join(stateDir, "config.yaml"),
    observedAt: new Date().toISOString(),
  };
}

function parseTool(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("missing tool text");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("continuity handoff between fresh agents", () => {
  it("lets Agent B continue Agent A's recorded next action from project identity alone", async () => {
    const repo = await createGitRepo();
    const stateDir = await mkdtemp("cb-e2e-state-");
    disposables.push(repo, stateDir);
    const real = await fs.promises.realpath(repo);
    await commitFile(
      repo,
      "README.md",
      "# Corpus\n\nCorpus retrieves private knowledge for coding agents.\n",
      "introduce corpus"
    );
    await commitFile(
      repo,
      "src/greet.ts",
      "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n",
      "add greeting helper"
    );

    const config = configFor(real, stateDir);
    const storeA = new ContinuityStore(config, { stateDir });

    // Agent A: records the work and leaves a concrete next action.
    await storeA.upsertTask({
      project: "corpus",
      taskId: "greet-docs",
      title: "Document the greeting helper",
      objective: "Add CHANGELOG.md describing the greeting helper added in this session.",
      state: "in_progress",
      nextActions: ["Create CHANGELOG.md with an Unreleased section naming greet()"],
      provenance: { name: "agent-a", harness: "test" },
    });
    await storeA.createHandoff({
      project: "corpus",
      taskId: "greet-docs",
      handoffId: "agent-a-done",
      status: "ready_for_review",
      summary: "Added src/greet.ts. Documentation is still missing.",
      findings: ["greet() returns a hello string"],
      decisions: ["Keep the helper dependency-free"],
      nextActions: ["Create CHANGELOG.md with an Unreleased section naming greet()"],
      relevantFiles: ["src/greet.ts"],
      agent: { name: "agent-a", harness: "test" },
    });

    // Fresh Agent B: new process-equivalent objects, only knows project name.
    const storeB = new ContinuityStore(config, { stateDir });
    const serviceB = new ContextService(config);
    const briefing = await buildProjectBriefing(serviceB, storeB, "corpus");
    expect(briefing.project.name).toBe("corpus");
    expect(briefing.purpose?.excerpt).toMatch(/private knowledge/);
    expect(briefing.continuity.latestHandoffs[0]?.handoffId).toBe("agent-a-done");
    const next = briefing.recommendedFocus.items[0]?.text ?? "";
    expect(next).toMatch(/CHANGELOG.md/);

    await commitFile(
      repo,
      "CHANGELOG.md",
      "# Changelog\n\n## Unreleased\n\n- Add greet() helper in src/greet.ts\n",
      "document greeting helper"
    );
    const existing = await storeB.getTask({ project: "corpus", taskId: "greet-docs" });
    await storeB.upsertTask({
      project: "corpus",
      taskId: "greet-docs",
      title: existing.title,
      objective: existing.objective,
      state: "complete",
      expectedUpdatedAt: existing.updatedAt,
      nextActions: [],
      provenance: { name: "agent-b", harness: "test" },
    });
    await storeB.createHandoff({
      project: "corpus",
      taskId: "greet-docs",
      handoffId: "agent-b-done",
      status: "complete",
      summary: "Added CHANGELOG.md as instructed by the previous handoff.",
      findings: ["Agent A added greet(); Agent B documented it"],
      nextActions: [],
      relevantFiles: ["CHANGELOG.md", "src/greet.ts"],
      agent: { name: "agent-b", harness: "test" },
    });

    expect(await fs.promises.readFile(path.join(repo, "CHANGELOG.md"), "utf8")).toMatch(/greet\(\)/);
    const log = await git(repo, ["log", "--oneline"]);
    expect(log).toMatch(/document greeting helper/);
    const after = await buildProjectBriefing(serviceB, storeB, "corpus");
    expect(after.continuity.latestHandoffs[0]?.handoffId).toBe("agent-b-done");
    expect(after.continuity.openTasks).toHaveLength(0);
  });
});

describe("fresh ChatGPT-compatible Streamable HTTP client", () => {
  it("answers strategic questions from a briefing with no prior conversation", async () => {
    const repo = await createGitRepo();
    const stateDir = await mkdtemp("cb-e2e-http-");
    disposables.push(repo, stateDir);
    const real = await fs.promises.realpath(repo);
    await commitFile(repo, "README.md", "# Corpus\n\nCorpus is the founder's knowledge retrieval project.\n", "readme");
    await commitFile(repo, "DESIGN.md", "# Design\n\nLocal index. MCP query surface. No multi-tenant SaaS.\n", "design");
    await commitFile(repo, "TODO.md", "- [ ] Decide whether the first index is file-backed\n", "todo");

    const configPath = path.join(stateDir, "config.yaml");
    await fs.promises.writeFile(
      configPath,
      `version: 1\nprojects:\n  - name: corpus\n    path: ${real}\n    context: ["README.md", "DESIGN.md", "TODO.md"]\n`,
      "utf8"
    );

    const runtime = bootstrap({ configPath, stateDir, allowWrites: true });
    await dispatchTool(runtime, "context_task_upsert", {
      project: "corpus",
      taskId: "index-shape",
      title: "Choose the first index shape",
      objective: "Pick a file-backed index before adding remote search.",
      state: "blocked",
      nextActions: ["Founder decides: file-backed vs sqlite"],
      provenance: { name: "agent-a", harness: "test" },
    });
    await dispatchTool(runtime, "context_handoff_create", {
      project: "corpus",
      taskId: "index-shape",
      handoffId: "needs-decision",
      status: "blocked",
      summary: "Implementation paused pending index decision.",
      decisions: ["Stay local-first; no cloud index"],
      blockers: ["Need a founder decision on file-backed vs sqlite"],
      nextActions: ["Founder decides: file-backed vs sqlite"],
      agent: { name: "agent-a", harness: "test" },
    });

    const token = "e2e-strategic-token-0123456789";
    const started = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      token,
      runtime: bootstrap({ configPath, stateDir, allowWrites: false }),
      allowWrites: false,
    });
    servers.push(started);

    const transport = new StreamableHTTPClientTransport(new URL(started.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "chatgpt-sim", version: "0.2.0" });
    await client.connect(transport);

    const projects = parseTool(await client.callTool({ name: "context_list_projects", arguments: {} }));
    expect(JSON.stringify(projects)).toMatch(/corpus/);

    const briefing = parseTool(await client.callTool({
      name: "context_project_briefing",
      arguments: { project: "corpus" },
    })) as {
      purpose?: { excerpt: string };
      architecture?: { excerpt: string };
      live: { branch: string | null; recentCommits: Array<{ subject: string }> };
      continuity: {
        openTasks: Array<{ state: string }>;
        decisions: Array<{ text: string; source: { claimType: string } }>;
        blockers: Array<{ text: string }>;
      };
      recommendedFocus: { rationale: string; items: Array<{ text: string }> };
    };

    expect(briefing.purpose?.excerpt).toMatch(/knowledge retrieval/);
    expect(briefing.architecture?.excerpt).toMatch(/Local index/);
    expect(briefing.live.branch).toBe("main");
    expect(briefing.live.recentCommits.some((c) => /readme|design|todo/i.test(c.subject))).toBe(true);
    expect(briefing.continuity.openTasks.some((t) => t.state === "blocked")).toBe(true);
    expect(briefing.continuity.decisions[0]?.text).toMatch(/local-first/);
    expect(briefing.continuity.decisions[0]?.source.claimType).toBe("agent_record");
    expect(briefing.continuity.blockers[0]?.text).toMatch(/file-backed vs sqlite/);
    expect(briefing.recommendedFocus.rationale).toMatch(/blocked/i);
    expect(briefing.recommendedFocus.items[0]?.text).toMatch(/file-backed vs sqlite/);

    await client.close();
    await transport.close();
  });
});
