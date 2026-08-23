import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, cleanup, createGitRepo, commitFile, git } from "./helpers.js";
import { ContextService } from "../core/context.js";
import { SecurityPolicy } from "../core/security.js";
import type { ResolvedConfig } from "../core/types.js";

function makeConfig(root: string, name = "proj"): ResolvedConfig {
  return {
    version: 1,
    projects: [{ name, canonicalPath: root, originalPath: root, contextPatterns: ["TODO.md", "docs/**/*.md"] }],
    sessionArtifacts: { patterns: [] },
    search: { maxResults: 50, maxFileSizeBytes: 512 * 1024 },
    limits: { maxFileSizeBytes: 256 * 1024, maxDiffBytes: 128 * 1024, maxSearchResults: 50 },
    configPath: path.join(root, "config.yaml"),
    observedAt: new Date().toISOString(),
  };
}

describe("ContextService", () => {
  let repo: string;
  let real: string;

  beforeEach(async () => {
    repo = await createGitRepo();
    real = await fs.promises.realpath(repo);
    await commitFile(repo, "TODO.md", "todo initial", "init");
    await fs.promises.mkdir(path.join(repo, "docs"), { recursive: true });
    await fs.promises.writeFile(path.join(repo, "docs", "architecture.md"), "# Arch");
  });

  afterEach(async () => {
    await cleanup(repo);
  });

  it("listProjects returns configured projects", async () => {
    const svc = new ContextService(makeConfig(real));
    const projects = await svc.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("proj");
    expect(projects[0]!.isGitRepo).toBe(true);
  });

  it("projectSnapshot aggregates git, worktrees, docs, provenance", async () => {
    const svc = new ContextService(makeConfig(real));
    const snap = await svc.projectSnapshot("proj");
    expect(snap.project.name).toBe("proj");
    expect(snap.git).toBeDefined();
    expect(snap.worktrees.length).toBeGreaterThanOrEqual(1);
    expect(snap.contextDocuments.some((d) => d.path === "TODO.md")).toBe(true);
    expect(snap.provenance.observedAt).toBeTruthy();
    expect(snap.recentChanges).toBeDefined();
  });

  it("listWorktrees and worktreeSnapshot", async () => {
    await git(repo, ["branch", "feature"]);
    const wt = await mkdtemp();
    try {
      await git(repo, ["worktree", "add", wt, "feature"]);
      const svc = new ContextService(makeConfig(real));
      const wts = await svc.listWorktrees("proj");
      expect(wts.length).toBe(2);
      const realWt = await fs.promises.realpath(wt);
      await expect(svc.worktreeSnapshot("proj", realWt)).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    } finally {
      try {
        await git(repo, ["worktree", "remove", "--force", wt]);
      } catch {}
      await cleanup(wt).catch(() => {});
    }
  });

  it("recentChanges returns commits and diffStat", async () => {
    await commitFile(repo, "a.txt", "a", "second");
    const svc = new ContextService(makeConfig(real));
    const rc = await svc.recentChanges("proj", { limit: 5 });
    expect(rc.commits.length).toBeGreaterThanOrEqual(2);
    expect(typeof rc.diffStat).toBe("string");
  });

  it("compare base vs target", async () => {
    const sha1 = await commitFile(repo, "a.txt", "a", "commit a");
    await git(repo, ["branch", "feat"]);
    await commitFile(repo, "b.txt", "b", "commit b on main");
    await git(repo, ["checkout", "feat"]);
    await commitFile(repo, "c.txt", "c", "commit c on feat");
    await git(repo, ["checkout", "main"]);

    const svc = new ContextService(makeConfig(real));
    const cmp = await svc.compare("proj", "main", "feat");
    expect(cmp.base).toBe("main");
    expect(cmp.target).toBe("feat");
    expect(cmp.mergeBase).toBeTruthy();
    expect(cmp.commits.length).toBeGreaterThanOrEqual(1);
    expect(cmp.commits[0]!.subject).toContain("commit c");
  });

  it("compare with includeDiff bounded", async () => {
    await commitFile(repo, "a.txt", "a", "init a");
    await git(repo, ["branch", "feat2"]);
    await fs.promises.writeFile(path.join(repo, "a.txt"), "modified a");
    await git(repo, ["checkout", "feat2"]);
    await fs.promises.writeFile(path.join(repo, "a.txt"), "feature change " + "x".repeat(5000));
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["commit", "-m", "feat change"]);
    await git(repo, ["checkout", "main"]);

    const svc = new ContextService(makeConfig(real));
    const cmp = await svc.compare("proj", "main", "feat2", { includeDiff: true, maxDiffBytes: 100 });
    expect(cmp.diff).not.toBeNull();
    expect(cmp.truncated).toBe(true);
  });

  it("compare rejects invalid ref with shell metachars", async () => {
    const svc = new ContextService(makeConfig(real));
    await expect(svc.compare("proj", "main; rm -rf /", "feat")).rejects.toThrow(/Invalid ref/);
    await expect(svc.compare("proj", "main", "feat$(evil)")).rejects.toThrow(/Invalid ref/);
    await expect(svc.compare("proj", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "HEAD:.env")).rejects.toThrow(/Invalid ref/);
  });

  it("search within project", async () => {
    await fs.promises.writeFile(path.join(repo, "needle.txt"), "find me here");
    const svc = new ContextService(makeConfig(real));
    const res = await svc.search("proj", "find me");
    expect(res.results.some((r) => r.path === "needle.txt")).toBe(true);
  });

  it("listContextDocuments and readContextDocument", async () => {
    const svc = new ContextService(makeConfig(real));
    const docs = await svc.listContextDocuments("proj");
    expect(docs.some((d) => d.path === "TODO.md")).toBe(true);
    const content = await svc.readContextDocument("proj", "TODO.md");
    expect(content.content).toContain("todo initial");
  });

  it("readContextDocument denies traversal", async () => {
    const svc = new ContextService(makeConfig(real));
    await expect(svc.readContextDocument("proj", "../etc/passwd")).rejects.toThrow();
    await expect(svc.readContextDocument("proj", "TODO.md/../../etc/passwd")).rejects.toThrow();
  });

  it("throws NOT_FOUND for unknown project", async () => {
    const svc = new ContextService(makeConfig(real));
    await expect(svc.projectSnapshot("not-exist")).rejects.toThrow(/Project not found/);
    await expect(svc.listWorktrees("not-exist")).rejects.toThrow(/Project not found/);
  });

  it("handles project with spaces", async () => {
    const base = await mkdtemp();
    const spaced = path.join(base, "project with spaces");
    try {
      await fs.promises.mkdir(spaced, { recursive: true });
      // init git
      await git(spaced, ["init", "-b", "main"]);
      await git(spaced, ["config", "user.email", "t@t.t"]);
      await git(spaced, ["config", "user.name", "t"]);
      await fs.promises.writeFile(path.join(spaced, "TODO.md"), "spaced todo");
      await git(spaced, ["add", "."]);
      await git(spaced, ["commit", "-m", "init"]);
      const realSpaced = await fs.promises.realpath(spaced);
      const svc = new ContextService(makeConfig(realSpaced, "spaced"));
      const snap = await svc.projectSnapshot("spaced");
      expect(snap.project.canonicalPath).toBe(realSpaced);
      expect(snap.contextDocuments.some((d) => d.path === "TODO.md")).toBe(true);
    } finally {
      await cleanup(base);
    }
  });
});
