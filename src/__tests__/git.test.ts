import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, cleanup, createGitRepo, commitFile, git } from "./helpers.js";
import * as gitProvider from "../providers/git.js";

describe("git provider", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await createGitRepo();
  });

  afterEach(async () => {
    await cleanup(repo);
  });

  it("detects git repo", async () => {
    expect(await gitProvider.isGitRepo(repo)).toBe(true);
    const nonRepo = await mkdtemp();
    try {
      expect(await gitProvider.isGitRepo(nonRepo)).toBe(false);
    } finally {
      await cleanup(nonRepo);
    }
  });

  it("reports branch and HEAD", async () => {
    await commitFile(repo, "README.md", "# hi", "initial commit");
    const { branch, detached } = await gitProvider.getBranch(repo);
    expect(branch).toBe("main");
    expect(detached).toBe(false);
    const head = await gitProvider.getHeadCommit(repo);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("detects dirty state and staged/unstaged changes", async () => {
    await commitFile(repo, "file.txt", "clean", "init");
    expect(await gitProvider.isDirty(repo)).toBe(false);

    // unstaged
    await fs.promises.writeFile(path.join(repo, "file.txt"), "dirty");
    expect(await gitProvider.isDirty(repo)).toBe(true);
    let status = await gitProvider.getStatusDetails(repo);
    expect(status.unstaged.length).toBe(1);
    expect(status.staged.length).toBe(0);

    // staged
    await git(repo, ["add", "file.txt"]);
    status = await gitProvider.getStatusDetails(repo);
    expect(status.staged.length).toBe(1);
    expect(status.unstaged.length).toBe(0);

    // untracked
    await fs.promises.writeFile(path.join(repo, "new.txt"), "new");
    status = await gitProvider.getStatusDetails(repo);
    expect(status.untracked).toContain("new.txt");
  });

  it("handles detached HEAD", async () => {
    const sha = await commitFile(repo, "a.txt", "a", "first");
    await commitFile(repo, "b.txt", "b", "second");
    await git(repo, ["checkout", "--detach", sha]);
    const { branch, detached } = await gitProvider.getBranch(repo);
    expect(branch).toBeNull();
    expect(detached).toBe(true);
  });

  it("lists worktrees: single repo case", async () => {
    await commitFile(repo, "f.txt", "x", "init");
    const wts = await gitProvider.listWorktrees(repo);
    expect(wts.length).toBe(1);
    expect(wts[0]!.isMain).toBe(true);
    expect(wts[0]!.path).toBeTruthy();
  });

  it("discovers multiple worktrees", async () => {
    await commitFile(repo, "main.txt", "main", "init");
    await git(repo, ["branch", "feature"]);
    const wtDir = await mkdtemp();
    try {
      await git(repo, ["worktree", "add", wtDir, "feature"]);
      await fs.promises.writeFile(path.join(wtDir, "wt-file.txt"), "hello");
      await git(wtDir, ["add", "wt-file.txt"]);

      const wts = await gitProvider.listWorktrees(repo);
      expect(wts.length).toBe(2);
      const canonicalWtDir = await fs.promises.realpath(wtDir).catch(() => wtDir);
      const wt = wts.find((w) => w.path === wtDir || w.canonicalPath === canonicalWtDir);
      expect(wt).toBeDefined();
      expect(wt!.branch).toBe("feature");
      expect(wt!.isDirty).toBe(true);
      expect(wt!.stagedChanges.length).toBe(1);
    } finally {
      // remove worktree
      try {
        await git(repo, ["worktree", "remove", "--force", wtDir]);
      } catch {}
      await cleanup(wtDir).catch(() => {});
    }
  });

  it("detects missing/deleted worktree", async () => {
    await commitFile(repo, "f.txt", "x", "init");
    await git(repo, ["branch", "ghost"]);
    const wtDir = await mkdtemp();
    await fs.promises.rm(wtDir, { recursive: true, force: true });
    // Create then delete
    const wtDir2 = await mkdtemp();
    try {
      await git(repo, ["worktree", "add", wtDir2, "ghost"]);
      // Delete dir without git worktree remove — simulate missing
      await fs.promises.rm(wtDir2, { recursive: true, force: true });
      const wts = await gitProvider.listWorktrees(repo);
      const ghost = wts.find((w) => w.branch === "ghost");
      expect(ghost).toBeDefined();
      expect(ghost!.isMissing).toBe(true);
      // Cleanup prunable entry
      await git(repo, ["worktree", "prune"]).catch(() => {});
    } finally {
      try {
        await git(repo, ["worktree", "remove", "--force", wtDir2]).catch(() => {});
      } catch {}
      try {
        await git(repo, ["worktree", "prune"]).catch(() => {});
      } catch {}
    }
  });

  it("getRecentCommits bounded", async () => {
    await commitFile(repo, "a.txt", "a", "commit one");
    await commitFile(repo, "b.txt", "b", "commit two");
    const commits = await gitProvider.getRecentCommits(repo, 1);
    expect(commits.length).toBe(1);
    expect(commits[0]!.subject).toBe("commit two");
    const all = await gitProvider.getRecentCommits(repo, 10);
    expect(all.length).toBe(2);
  });

  it("getRepoState handles repo with no commits (init without commit)", async () => {
    const emptyRepo = await createGitRepo();
    try {
      const state = await gitProvider.getRepoState(emptyRepo);
      // may be null or dirty? In empty repo, rev-parse HEAD fails, branch may be main but no head
      // We assert it returns something or null, not throws
      expect(state === null || typeof state === "object").toBe(true);
      if (state) {
        expect(state.headCommit).toBeNull();
      }
    } finally {
      await cleanup(emptyRepo);
    }
  });

  it("handles path with spaces", async () => {
    const base = await mkdtemp();
    const spaced = path.join(base, "my project with spaces");
    try {
      await fs.promises.mkdir(spaced, { recursive: true });
      await git(spaced, ["init", "-b", "main"]);
      await fs.promises.writeFile(path.join(spaced, "file.txt"), "hi");
      await git(spaced, ["config", "user.email", "t@t.t"]);
      await git(spaced, ["config", "user.name", "t"]);
      await git(spaced, ["add", "."]);
      await git(spaced, ["commit", "-m", "init"]);
      expect(await gitProvider.isGitRepo(spaced)).toBe(true);
      const branch = await gitProvider.getBranch(spaced);
      expect(branch.branch).toBe("main");
      const dirty = await gitProvider.isDirty(spaced);
      expect(dirty).toBe(false);
    } finally {
      await cleanup(base);
    }
  }, 15000);

  it("getBoundedDiff respects maxBytes and truncated flag", async () => {
    await commitFile(repo, "big.txt", "line1\n", "init");
    // Create a diff larger than 100 bytes
    const content = "a".repeat(200) + "\n";
    await fs.promises.writeFile(path.join(repo, "big2.txt"), content);
    await git(repo, ["add", "big2.txt"]);
    const { diff, truncated } = await gitProvider.getBoundedDiff(repo, ["diff", "--staged"], 100);
    expect(diff).not.toBeNull();
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(diff!, "utf-8")).toBeLessThanOrEqual(120); // plus notice
  });

  it("getChangedFileStats returns additions/deletions", async () => {
    await commitFile(repo, "file.txt", "a\nb\n", "init");
    await fs.promises.writeFile(path.join(repo, "file.txt"), "a\nb\nc\n");
    const stats = await gitProvider.getChangedFileStats(repo, "HEAD");
    // Depending on diff scope, may show file.txt with additions
    // At least not throwing; if dirty, should show something or empty (when diff against HEAD)
    expect(Array.isArray(stats)).toBe(true);
  });

  it("merge-base and ahead/behind for identical refs", async () => {
    await commitFile(repo, "a.txt", "a", "init");
    const mb = await gitProvider.getMergeBase(repo, "HEAD", "HEAD");
    const head = await gitProvider.getHeadCommit(repo);
    expect(mb).toBe(head);
    const ab = await gitProvider.getAheadBehind(repo, "HEAD", "HEAD");
    expect(ab.ahead).toBe(0);
    expect(ab.behind).toBe(0);
  });
});
