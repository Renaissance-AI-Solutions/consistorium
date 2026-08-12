/**
 * Context service — orchestrates providers behind a single facade.
 * This is the core query layer consumed by MCP tools.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ResolvedConfig,
  ResolvedProject,
  ProjectSnapshot,
  WorktreeInfo,
  RecentChanges,
  CompareResult,
  SearchResponse,
  ContextDocSummary,
  ContextDocContent,
  SessionSummary,
  SessionSnapshot,
} from "./types.js";
import { DEFAULT_LIMITS } from "./types.js";
import { SecurityPolicy } from "./security.js";
import * as git from "../providers/git.js";
import * as docs from "../providers/documents.js";
import * as search from "../providers/search.js";
import { GenericSessionAdapter, NoopSessionAdapter, type SessionAdapter } from "../adapters/session.js";

export class ContextService {
  private config: ResolvedConfig;
  private policy: SecurityPolicy;
  private sessionAdapter: SessionAdapter;

  constructor(config: ResolvedConfig, policy?: SecurityPolicy, adapter?: SessionAdapter) {
    this.config = config;
    this.policy = policy ?? new SecurityPolicy(config.projects.map((p) => p.canonicalPath));
    if (adapter) {
      this.sessionAdapter = adapter;
    } else {
      this.sessionAdapter =
        config.sessionArtifacts.patterns.length > 0 ? new GenericSessionAdapter() : new NoopSessionAdapter();
    }
  }

  getConfig(): ResolvedConfig {
    return this.config;
  }

  getPolicy(): SecurityPolicy {
    return this.policy;
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  async listProjects(): Promise<{ name: string; canonicalPath: string; isGitRepo: boolean }[]> {
    const results: { name: string; canonicalPath: string; isGitRepo: boolean }[] = [];
    for (const p of this.config.projects) {
      const isRepo = await git.isGitRepo(p.canonicalPath).catch(() => false);
      results.push({ name: p.name, canonicalPath: p.canonicalPath, isGitRepo: isRepo });
    }
    return results;
  }

  async getProject(name: string): Promise<ResolvedProject | null> {
    const found = this.config.projects.find((p) => p.name === name);
    return found ?? null;
  }

  // -------------------------------------------------------------------------
  // Project snapshot — the hero tool
  // -------------------------------------------------------------------------

  async projectSnapshot(
    name: string,
    opts?: { recentLimit?: number; includeSessions?: boolean }
  ): Promise<ProjectSnapshot> {
    const project = this.config.projects.find((p) => p.name === name);
    if (!project) throw Object.assign(new Error(`Project not found: ${name}`), { code: "NOT_FOUND" });

    const isRepo = await git.isGitRepo(project.canonicalPath).catch(() => false);
    const worktrees: WorktreeInfo[] = isRepo ? await git.listWorktrees(project.canonicalPath).catch(() => []) : [];
    const gitState = isRepo ? await git.getRepoState(project.canonicalPath, opts?.recentLimit ?? 10).catch(() => null) : null;

    const contextDocs = await docs
      .discoverContextDocuments(project, this.policy)
      .catch(() => [] as ContextDocSummary[]);

    // Recent changes for the main repo state
    let recentChanges: RecentChanges | undefined;
    if (isRepo) {
      try {
        const commits = await git.getRecentCommits(project.canonicalPath, opts?.recentLimit ?? 10);
        const diffStat = await git.getDiffStat(project.canonicalPath).catch(() => "");
        const changedFiles = await git.getChangedFileStats(project.canonicalPath).catch(() => []);
        recentChanges = { commits, changedFiles, diffStat };
      } catch {
        // ignore
      }
    }

    let sessions: SessionSummary[] = [];
    if (opts?.includeSessions !== false) {
      sessions = await this.sessionAdapter.listSessions(this.config, this.policy).catch(() => []);
      // Filter to this project
      sessions = sessions.filter((s) => s.project === project.name || s.sourcePath.startsWith(project.canonicalPath + path.sep));
    }

    return {
      project: { name: project.name, canonicalPath: project.canonicalPath, isGitRepo: isRepo },
      git: gitState ?? undefined,
      worktrees,
      contextDocuments: contextDocs,
      recentChanges,
      sessions,
      provenance: {
        observedAt: new Date().toISOString(),
        projectName: project.name,
        projectPath: project.canonicalPath,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Worktrees
  // -------------------------------------------------------------------------

  async listWorktrees(projectName: string): Promise<WorktreeInfo[]> {
    const project = this.config.projects.find((p) => p.name === projectName);
    if (!project) throw Object.assign(new Error(`Project not found: ${projectName}`), { code: "NOT_FOUND" });
    return git.listWorktrees(project.canonicalPath);
  }

  async worktreeSnapshot(projectName: string, worktreePath: string): Promise<WorktreeInfo> {
    const project = this.config.projects.find((p) => p.name === projectName);
    if (!project) throw Object.assign(new Error(`Project not found: ${projectName}`), { code: "NOT_FOUND" });

    // First, list worktrees — they may reside outside the allowed root but are still
    // legitimate children of an allowed repo (git worktree add can place them anywhere).
    // So we check worktree membership before applying policy to allow discovered paths.
    const worktrees = await git.listWorktrees(project.canonicalPath);

    // Try to resolve requested path lexically/canonical without policy first for lookup
    let lexCanonical: string | null = null;
    try {
      lexCanonical = await fs.promises.realpath(worktreePath).catch(() => path.normalize(path.resolve(worktreePath)));
      lexCanonical = lexCanonical.replace(/\/+$/, "") || "/";
      // Also try via SecurityPolicy realpath helper without deny — use helper
      // If lexCanonical matches a known worktree, return immediately without policy check.
      const foundByLex = worktrees.find(
        (w) => w.canonicalPath === lexCanonical || w.path === lexCanonical || w.path === worktreePath
      );
      if (foundByLex) return foundByLex;
    } catch { /* ignore */ }

    // For non-worktree paths, enforce allowlist
    const canonicalRequested = await this.policy.canonicalizeAndCheck(worktreePath).catch(() => {
      throw Object.assign(new Error(`Invalid worktree path: ${worktreePath}`), { code: "PATH_ESCAPE" });
    });

    const found = worktrees.find(
      (w) => w.canonicalPath === canonicalRequested || w.path === canonicalRequested || w.path === worktreePath
    );
    if (found) return found;

    // If not found in git worktree list, still try to snapshot that path if it's a git repo dir
    // This handles detached dirs that are not registered worktrees
    try {
      const stat = await fs.promises.stat(canonicalRequested);
      if (!stat.isDirectory()) throw new Error("not a directory");
    } catch {
      throw Object.assign(new Error(`Worktree not found: ${worktreePath}`), { code: "NOT_FOUND" });
    }

    const isRepo = await git.isGitRepo(canonicalRequested).catch(() => false);
    if (!isRepo) throw Object.assign(new Error(`Not a git repository: ${worktreePath}`), { code: "NOT_GIT_REPO" });

    const branchInfo = await git.getBranch(canonicalRequested);
    const head = await git.getHeadCommit(canonicalRequested);
    const dirty = await git.isDirty(canonicalRequested);
    const status = await git.getStatusDetails(canonicalRequested);
    const up = await git.getUpstreamInfoFixed(canonicalRequested).catch(() => ({ upstream: null, ahead: null, behind: null }));

    let canonicalWt: string;
    try {
      canonicalWt = await fs.promises.realpath(canonicalRequested);
    } catch {
      canonicalWt = path.normalize(canonicalRequested);
    }

    return {
      path: worktreePath,
      canonicalPath: canonicalWt,
      branch: branchInfo.branch,
      headCommit: head,
      headCommitShort: head ? head.slice(0, 7) : null,
      isDetached: branchInfo.detached,
      isDirty: dirty,
      isMain: false,
      isMissing: false,
      stagedChanges: status.staged,
      unstagedChanges: status.unstaged,
      untrackedFiles: status.untracked.slice(0, DEFAULT_LIMITS.maxUntrackedPreview),
      untrackedCount: status.untracked.length,
      ahead: up.ahead,
      behind: up.behind,
      upstream: up.upstream,
      provenance: { observedAt: new Date().toISOString(), projectName: project.name, projectPath: project.canonicalPath },
    };
  }

  // -------------------------------------------------------------------------
  // Recent changes
  // -------------------------------------------------------------------------

  async recentChanges(
    projectName: string,
    opts?: { limit?: number; worktreePath?: string; includeDiffStat?: boolean }
  ): Promise<RecentChanges> {
    const project = this.config.projects.find((p) => p.name === projectName);
    if (!project) throw Object.assign(new Error(`Project not found: ${projectName}`), { code: "NOT_FOUND" });

    const cwd = opts?.worktreePath
      ? await this.policy.canonicalizeAndCheck(opts.worktreePath).catch(() => {
          throw Object.assign(new Error(`Invalid worktree path: ${opts?.worktreePath}`), { code: "PATH_ESCAPE" });
        })
      : project.canonicalPath;

    const limit = Math.min(opts?.limit ?? DEFAULT_LIMITS.maxCommitsDefault, DEFAULT_LIMITS.maxCommitsMax);
    const commits = await git.getRecentCommits(cwd, limit);
    const diffStat = opts?.includeDiffStat === false ? "" : await git.getDiffStat(cwd).catch(() => "");
    const changedFiles = await git.getChangedFileStats(cwd).catch(() => []);

    return { commits, changedFiles, diffStat };
  }

  // -------------------------------------------------------------------------
  // Compare
  // -------------------------------------------------------------------------

  async compare(
    projectName: string,
    base: string,
    target: string,
    opts?: { includeDiff?: boolean; maxDiffBytes?: number; worktreePath?: string }
  ): Promise<CompareResult> {
    const project = this.config.projects.find((p) => p.name === projectName);
    if (!project) throw Object.assign(new Error(`Project not found: ${projectName}`), { code: "NOT_FOUND" });
    if (!base || !target) throw Object.assign(new Error("base and target refs are required"), { code: "INVALID_ARG" });

    // Validate refs look sane (prevent injection into git args)
    // Allow: branch names, tags, SHAs, HEAD, refs/..., with :/ , -, _, ., /, but not shell metachars
    const refPattern = /^[a-zA-Z0-9._\/\-@^{~:]+$/;
    if (!refPattern.test(base) || !refPattern.test(target)) {
      throw Object.assign(new Error(`Invalid ref format: base=${base} target=${target}`), { code: "INVALID_REF" });
    }

    const cwd = opts?.worktreePath
      ? await this.policy.canonicalizeAndCheck(opts.worktreePath).catch(() => {
          throw Object.assign(new Error(`Invalid worktree path: ${opts?.worktreePath}`), { code: "PATH_ESCAPE" });
        })
      : project.canonicalPath;

    // Ensure cwd is inside allowed roots (already via policy) and is a git repo
    const isRepo = await git.isGitRepo(cwd).catch(() => false);
    if (!isRepo) throw Object.assign(new Error(`Not a git repository: ${cwd}`), { code: "NOT_GIT_REPO" });

    const mergeBase = await git.getMergeBase(cwd, base, target).catch(() => null);
    const { ahead, behind } = await git.getAheadBehind(cwd, base, target).catch(() => ({ ahead: null, behind: null }));

    // Commits in target not in base: target..base? Actually we want commits reachable from target but not base.
    // For compare base vs target, list commits in target ^ base — use "base..target"
    let commits: import("../core/types.js").CommitSummary[] = [];
    try {
      // Use log with range
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const format = "%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%P%x1e";
      const range = `${base}..${target}`;
      const { stdout } = (await execFileAsync("git", ["log", `--pretty=format:${format}`, range], {
        cwd,
        maxBuffer: 5 * 1024 * 1024,
        timeout: 15000,
        encoding: "utf-8",
      })) as { stdout: string };
      if (stdout.trim()) {
        const records = stdout.split("\x1e").filter((r: string) => r.trim().length > 0);
        commits = records.map((rec: string) => {
          const parts = rec.split("\x1f");
          const [sha = "", shortSha = "", subject = "", author = "", authorEmail = "", date = "", parentsRaw = ""] = parts;
          const parents = parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [];
          return { sha: sha.trim(), shortSha: shortSha.trim(), subject: subject.trim(), author: author.trim(), authorEmail: authorEmail.trim(), date: date.trim(), parents };
        });
        // Cap commits to avoid huge output
        if (commits.length > 100) commits = commits.slice(0, 100);
      }
    } catch {
      commits = [];
    }

    const diffStat = await git.getDiffStat(cwd, base, target).catch(() => "");

    let diff: string | null = null;
    let truncated = false;
    if (opts?.includeDiff) {
      const maxBytes = Math.min(opts.maxDiffBytes ?? DEFAULT_LIMITS.maxDiffBytes, 500 * 1024);
      const res = await git.getBoundedDiff(cwd, ["diff", `${base}..${target}`], maxBytes);
      diff = res.diff;
      truncated = res.truncated;
    }

    return {
      base,
      target,
      mergeBase,
      aheadBy: ahead,
      behindBy: behind,
      commits,
      diffStat,
      diff,
      truncated,
      provenance: { observedAt: new Date().toISOString(), projectName: project.name, projectPath: project.canonicalPath },
    };
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  async listContextDocuments(projectName: string): Promise<ContextDocSummary[]> {
    const project = this.config.projects.find((p) => p.name === projectName);
    if (!project) throw Object.assign(new Error(`Project not found: ${projectName}`), { code: "NOT_FOUND" });
    return docs.discoverContextDocuments(project, this.policy);
  }

  async readContextDocument(
    projectName: string,
    requestedPath: string,
    opts?: { maxBytes?: number }
  ): Promise<ContextDocContent> {
    const project = this.config.projects.find((p) => p.name === projectName);
    if (!project) throw Object.assign(new Error(`Project not found: ${projectName}`), { code: "NOT_FOUND" });
    const maxBytes = opts?.maxBytes ? Math.min(opts.maxBytes, 1024 * 1024) : undefined;
    return docs.readContextDocument(project, this.policy, requestedPath, maxBytes ? { maxBytes } : undefined);
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async search(
    projectName: string,
    query: string,
    opts?: { maxResults?: number; caseSensitive?: boolean; includeGlobs?: string[] }
  ): Promise<SearchResponse> {
    const project = this.config.projects.find((p) => p.name === projectName);
    if (!project) throw Object.assign(new Error(`Project not found: ${projectName}`), { code: "NOT_FOUND" });
    return search.searchInProject({
      query,
      project,
      policy: this.policy,
      maxResults: opts?.maxResults,
      caseSensitive: opts?.caseSensitive,
      includeGlobs: opts?.includeGlobs,
    });
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async listAgentSessions(projectName?: string): Promise<SessionSummary[]> {
    const all = await this.sessionAdapter.listSessions(this.config, this.policy);
    if (projectName) {
      return all.filter((s) => s.project === projectName || s.sourcePath.includes(projectName));
    }
    return all;
  }

  async sessionSnapshot(id: string): Promise<SessionSnapshot | null> {
    return this.sessionAdapter.getSessionSnapshot(this.config, this.policy, id);
  }
}
