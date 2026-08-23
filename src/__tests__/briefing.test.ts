import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ContextService } from "../core/context.js";
import { ContinuityStore } from "../core/continuity.js";
import { buildProjectBriefing } from "../core/briefing.js";
import type { ResolvedConfig } from "../core/types.js";
import { cleanup, commitFile, createGitRepo, mkdtemp } from "./helpers.js";

const disposables: string[] = [];

function configFor(repo: string, stateDir: string): ResolvedConfig {
  return {
    version: 1,
    projects: [{
      name: "corpus",
      canonicalPath: repo,
      originalPath: repo,
      contextPatterns: ["README.md", "DESIGN.md", "TODO.md", "docs/**/*.md"],
    }],
    sessionArtifacts: { patterns: [] },
    search: { maxResults: 50, maxFileSizeBytes: 512 * 1024 },
    limits: { maxFileSizeBytes: 256 * 1024, maxDiffBytes: 128 * 1024, maxSearchResults: 50, maxWorktrees: 50 },
    configPath: path.join(stateDir, "config.yaml"),
    observedAt: new Date().toISOString(),
  };
}

afterEach(async () => {
  while (disposables.length) await cleanup(disposables.pop()!);
});

describe("project briefing", () => {
  it("reaches the architecture doc even when plan docs could fill the cap", async () => {
    // Regression: the loader stopped at MAX_DOCS while walking a fixed list
    // that put TODO/ROADMAP/IDEA ahead of the architecture doc, so the
    // architecture slot came back empty for repos that have one.
    const repo = await createGitRepo();
    const stateDir = await mkdtemp("cb-brief-arch-");
    disposables.push(repo, stateDir);
    await commitFile(repo, "README.md", "# Corpus\n\nCorpus retrieves private knowledge.\n", "readme");
    await commitFile(repo, "TODO.md", "- [ ] a todo\n", "todo");
    await commitFile(repo, "ROADMAP.md", "# Roadmap\n\nlater\n", "roadmap");
    await commitFile(repo, "IDEA.md", "# Idea\n\nsomething\n", "idea");
    await commitFile(
      repo,
      "01-architecture-and-specs.md",
      "# Architecture\n\nLocal index, MCP query surface, no multi-tenant SaaS.\n",
      "architecture"
    );

    const real = await fs.promises.realpath(repo);
    const config = configFor(real, stateDir);
    config.projects[0]!.contextPatterns = [
      "README.md",
      "TODO.md",
      "ROADMAP.md",
      "IDEA.md",
      "01-architecture-and-specs.md",
    ];
    const service = new ContextService(config);
    const store = new ContinuityStore(config, { stateDir });

    const briefing = await buildProjectBriefing(service, store, "corpus");
    expect(briefing.purpose?.path).toBe("README.md");
    expect(briefing.architecture?.path).toBe("01-architecture-and-specs.md");
    expect(briefing.architecture?.excerpt).toMatch(/Local index/);
  });

  it("assembles live git, allowlisted docs, and agent-recorded continuity with provenance", async () => {
    const repo = await createGitRepo();
    const stateDir = await mkdtemp("cb-brief-");
    disposables.push(repo, stateDir);
    await commitFile(
      repo,
      "README.md",
      "# Corpus\n\nCorpus is a retrieval system for private knowledge.\n\nMore detail follows.",
      "add readme"
    );
    await commitFile(
      repo,
      "DESIGN.md",
      "# Design\n\nUse a local index plus an MCP query surface.",
      "add design"
    );
    await commitFile(repo, "TODO.md", "- [ ] ship the query API\n", "add todo");

    const config = configFor(await fs.promises.realpath(repo), stateDir);
    const service = new ContextService(config);
    const store = new ContinuityStore(config, { stateDir });

    const task = await store.upsertTask({
      project: "corpus",
      taskId: "query-api",
      title: "Ship query API",
      objective: "Expose a bounded query endpoint",
      state: "in_progress",
      nextActions: ["Write the handler tests"],
      provenance: { name: "agent-a", harness: "hermes" },
    });
    expect(task.taskId).toBe("query-api");

    await store.createHandoff({
      project: "corpus",
      taskId: "query-api",
      handoffId: "h-agent-a",
      status: "ready_for_review",
      summary: "Index works; query endpoint is next.",
      decisions: ["Keep the store local-first"],
      blockers: [],
      nextActions: ["Write the handler tests"],
      agent: { name: "agent-a", harness: "hermes" },
    });

    const briefing = await buildProjectBriefing(service, store, "corpus");
    expect(briefing.project.name).toBe("corpus");
    expect(briefing.purpose?.excerpt).toMatch(/retrieval system/);
    expect(briefing.architecture?.excerpt).toMatch(/local index/);
    expect(briefing.live.branch).toBe("main");
    expect(briefing.live.head).toBeTruthy();
    expect(briefing.continuity.openTasks).toHaveLength(1);
    expect(briefing.continuity.latestHandoffs[0]?.handoffId).toBe("h-agent-a");
    expect(briefing.continuity.decisions.some((d) => d.text.includes("local-first"))).toBe(true);
    expect(briefing.recommendedFocus.items[0]?.text).toMatch(/handler tests/);
    expect(briefing.recommendedFocus.items[0]?.source.claimType).toBe("agent_record");
    expect(briefing.provenance.sources.some((s) => s.kind === "git" && s.claimType === "live_observation")).toBe(true);
    expect(briefing.caveats.some((c) => c.includes("agent-recorded"))).toBe(true);
  });

  it("does not invent purpose or architecture when those documents are absent", async () => {
    const repo = await createGitRepo();
    const stateDir = await mkdtemp("cb-brief-empty-");
    disposables.push(repo, stateDir);
    await commitFile(repo, "src.ts", "export const n = 1;\n", "code only");
    const config = configFor(await fs.promises.realpath(repo), stateDir);
    const briefing = await buildProjectBriefing(new ContextService(config), new ContinuityStore(config, { stateDir }), "corpus");
    expect(briefing.purpose).toBeUndefined();
    expect(briefing.architecture).toBeUndefined();
    expect(briefing.recommendedFocus.rationale).toMatch(/no continuity records/i);
  });

  it("prefers recorded blockers over new-work next actions", async () => {
    const repo = await createGitRepo();
    const stateDir = await mkdtemp("cb-brief-block-");
    disposables.push(repo, stateDir);
    await commitFile(repo, "README.md", "# App\n\nA demo.\n", "readme");
    const config = configFor(await fs.promises.realpath(repo), stateDir);
    const store = new ContinuityStore(config, { stateDir });
    await store.upsertTask({
      project: "corpus",
      taskId: "blocked-task",
      title: "Unblock deploy",
      objective: "Need a decision on hosting",
      state: "blocked",
      nextActions: ["Decide on hosting"],
    });
    const briefing = await buildProjectBriefing(new ContextService(config), store, "corpus");
    expect(briefing.recommendedFocus.rationale).toMatch(/blocked/i);
    expect(briefing.continuity.blockers.length).toBeGreaterThan(0);
  });
});
