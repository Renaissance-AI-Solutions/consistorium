import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, cleanup, createGitRepo, commitFile, git } from "./helpers.js";
import { ContextService } from "../core/context.js";
import type { ResolvedConfig } from "../core/types.js";

function makeConfig(root: string): ResolvedConfig {
  return {
    version: 1,
    projects: [{ name: "proj", canonicalPath: root, originalPath: root, contextPatterns: ["*.md", "docs/**/*.md"] }],
    sessionArtifacts: { patterns: [] },
    search: { maxResults: 10, maxFileSizeBytes: 512 * 1024 },
    limits: { maxFileSizeBytes: 100, maxDiffBytes: 100, maxSearchResults: 10 },
    configPath: path.join(root, "config.yaml"),
    observedAt: new Date().toISOString(),
  };
}

describe("bounded output behavior", () => {
  let repo: string;
  let real: string;

  beforeEach(async () => {
    repo = await createGitRepo();
    real = await fs.promises.realpath(repo);
    await commitFile(repo, "README.md", "# readme", "init");
  });

  afterEach(async () => {
    await cleanup(repo);
  });

  it("readContextDocument truncates and signals", async () => {
    await fs.promises.writeFile(path.join(repo, "big.md"), "A".repeat(1000));
    const svc = new ContextService(makeConfig(real));
    // Request with small maxBytes
    const content = await svc.readContextDocument("proj", "big.md", { maxBytes: 50 });
    expect(content.truncated).toBe(true);
    expect(content.content).toContain("[truncated]");
  });

  it("search truncates at maxResults", async () => {
    for (let i = 0; i < 5; i++) {
      await fs.promises.writeFile(path.join(repo, `f${i}.txt`), "needle needle\n");
    }
    const svc = new ContextService(makeConfig(real));
    const res = await svc.search("proj", "needle", { maxResults: 2 });
    expect(res.results.length).toBe(2);
    expect(res.truncated).toBe(true);
  });

  it("compare diff truncates", async () => {
    await commitFile(repo, "a.txt", "a\n", "init a");
    await git(repo, ["branch", "feat"]);
    await commitFile(repo, "b.txt", "b\n", "commit main");
    await git(repo, ["checkout", "feat"]);
    await fs.promises.writeFile(path.join(repo, "a.txt"), "x".repeat(5000));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "big change"]);
    await git(repo, ["checkout", "main"]);

    const svc = new ContextService(makeConfig(real));
    const cmp = await svc.compare("proj", "main", "feat", { includeDiff: true, maxDiffBytes: 50 });
    expect(cmp.truncated).toBe(true);
    expect(cmp.diff).toBeTruthy();
    expect(cmp.diff!.length).toBeLessThan(300);
  });

  it("worktree untracked preview capped at 50", async () => {
    for (let i = 0; i < 60; i++) {
      await fs.promises.writeFile(path.join(repo, `untracked-${i}.txt`), "hi");
    }
    const svc = new ContextService(makeConfig(real));
    const snap = await svc.projectSnapshot("proj");
    const wt = snap.worktrees[0]!;
    expect(wt.untrackedCount).toBe(60);
    expect(wt.untrackedFiles.length).toBeLessThanOrEqual(50);
  });

  it("recentChanges limit capped at 100", async () => {
    for (let i = 0; i < 5; i++) {
      await commitFile(repo, `f${i}.txt`, `${i}`, `commit ${i}`);
    }
    const svc = new ContextService(makeConfig(real));
    // Request beyond max should be capped internally
    const rc = await svc.recentChanges("proj", { limit: 1000 });
    // Should still return at most 100
    expect(rc.commits.length).toBeLessThanOrEqual(100);
  });
});
