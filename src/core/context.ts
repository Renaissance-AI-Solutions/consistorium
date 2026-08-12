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

function isWithinProjectRoot(projectRoot: string, candidate: string): boolean {
  const relative = path.relative(projectRoot, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

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

  async listProjects(): Promise<{
    name: string;
    canonicalPath: string;
    isGitRepo: boolean;
    gitAvailability: "available" | "not_git" | "unavailable";
  }[]> {
    const results: { name: string; canonicalPath: string; isGitRepo: boolean; gitAvailability: "available" | "not_git" | "unavailable" }[] = [];
    for (const p of this.config.projects) {
      const observed = await git.observeRepositoryState(p.canonicalPath, p.canonicalPath);
      results.push({ name: p.name, canonicalPath: p.canonicalPath, isGitRepo: observed.availability === "available", gitAvailability: observed.availability });
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

    const observedGit = await git.observeRepositoryState(project.canonicalPath, project.canonicalPath);
    const isRepo = observedGit.availability === "available";
    const worktrees: WorktreeInfo[] = isRepo
      ? await git.listWorktrees(project.canonicalPath, project.canonicalPath, this.config.limits.maxWorktrees ?? DEFAULT_LIMITS.maxWorktrees).catch(() => [])
      : [];
    const gitState = observedGit.availability === "not_git"
      ? null
      : await git.getRepoState(project.canonicalPath, opts?.recentLimit ?? 10).catch(() => null);

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
      project: { name: project.name, canonicalPath: project.canonicalPath, isGitRepo: isRepo, gitAvailability: observedGit.availability },
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
    return git.listWorktrees(project.canonicalPath, project.canonicalPath, this.config.limits.maxWorktrees ?? DEFAULT_LIMITS.maxWorktrees);
  }

  async worktreeSnapshot(projectName: string, worktreePath: string): Promise<WorktreeInfo> {
    const project = this.config.projects.find((p) => p.name === projectName);
    if (!project) throw Object.assign(new Error(`Project not found: ${projectName}`), { code: "NOT_FOUND" });

    // First, list worktrees for metadata. A linked worktree may be discoverable in
    // Git metadata while living outside the explicitly configured project root;
    // discovery does not grant permission to inspect it.
    const worktrees = await git.listWorktrees(project.canonicalPath, project.canonicalPath, this.config.limits.maxWorktrees ?? DEFAULT_LIMITS.maxWorktrees);

    // Enforce the allowlist before matching or inspecting any requested path.
    const canonicalRequested = await this.policy.canonicalizeAndCheck(worktreePath).catch(() => {
      throw Object.assign(new Error(`Invalid worktree path: ${worktreePath}`), { code: "PATH_ESCAPE" });
    });
    if (!isWithinProjectRoot(project.canonicalPath, canonicalRequested)) {
      throw Object.assign(new Error(`Worktree path is outside the explicitly configured project root: ${worktreePath}`), { code: "PATH_ESCAPE" });
    }

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

    const observed = await git.observeRepositoryState(canonicalRequested, project.canonicalPath);
    if (observed.availability !== "available") {
      return {
        path: worktreePath,
        canonicalPath: observed.worktreePath,
        branch: observed.branch,
        headCommit: observed.head,
        headCommitShort: observed.head ? observed.head.slice(0, 7) : null,
        isDetached: observed.isDetached === true,
        isDirty: null,
        isMain: false,
        isMissing: false,
        inspection: "unavailable",
        unavailableReason: observed.error ?? "canonical Git observation unavailable",
        stagedChanges: [],
        unstagedChanges: [],
        untrackedFiles: [],
        untrackedCount: 0,
        ahead: null,
        behind: null,
        upstream: null,
        provenance: { observedAt: observed.observedAt, projectName: project.name, projectPath: project.canonicalPath },
      };
    }

    const branchInfo = { branch: observed.branch, detached: observed.isDetached === true };
    const head = observed.head;
    const dirty = observed.isDirty;
    const status = await git.getStatusDetails(canonicalRequested);
    if (!status.available) {
      return {
        path: worktreePath,
        canonicalPath: canonicalRequested,
        branch: observed.branch,
        headCommit: observed.head,
        headCommitShort: observed.head ? observed.head.slice(0, 7) : null,
        isDetached: observed.isDetached === true,
        isDirty: null,
        isMain: false,
        isMissing: false,
        inspection: "unavailable",
        unavailableReason: status.error ?? "git status unavailable",
        stagedChanges: [],
        unstagedChanges: [],
        untrackedFiles: [],
        untrackedCount: 0,
        ahead: null,
        behind: null,
        upstream: null,
        provenance: { observedAt: observed.observedAt, projectName: project.name, projectPath: project.canonicalPath },
      };
    }
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
    if (!isWithinProjectRoot(project.canonicalPath, cwd)) {
      throw Object.assign(new Error(`Worktree path is outside the explicitly configured project root: ${cwd}`), { code: "PATH_ESCAPE" });
    }

    const observed = await git.observeRepositoryState(cwd, project.canonicalPath);
    if (observed.availability !== "available") {
      throw Object.assign(new Error(observed.error ?? `Git observation unavailable: ${cwd}`), {
        code: observed.availability === "not_git" ? "NOT_GIT_REPO" : "GIT_UNAVAILABLE",
      });
    }

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
    if (!isWithinProjectRoot(project.canonicalPath, cwd)) {
      throw Object.assign(new Error(`Worktree path is outside the explicitly configured project root: ${cwd}`), { code: "PATH_ESCAPE" });
    }

    // Ensure cwd is inside allowed roots (already via policy) and is a git repo
    const observed = await git.observeRepositoryState(cwd, project.canonicalPath);
    if (observed.availability !== "available") {
      throw Object.assign(new Error(observed.error ?? `Git observation unavailable: ${cwd}`), {
        code: observed.availability === "not_git" ? "NOT_GIT_REPO" : "GIT_UNAVAILABLE",
      });
    }

    const mergeBase = await git.getMergeBase(cwd, base, target).catch(() => null);
    const { ahead, behind } = await git.getAheadBehind(cwd, base, target).catch(() => ({ ahead: null, behind: null }));

    // Commits in target not in base: target..base? Actually we want commits reachable from target but not base.
    // For compare base vs target, list commits in target ^ base — use "base..target"
    const commits = await git.getCommitsBetween(cwd, base, target);

    const diffStat = await git.getDiffStat(cwd, base, target).catch(() => "");

    let diff: string | null = null;
    let truncated = false;
    if (opts?.includeDiff) {
      const maxBytes = Math.min(opts.maxDiffBytes ?? this.config.limits.maxDiffBytes, this.config.limits.maxDiffBytes, 500 * 1024);
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
    const maxBytes = opts?.maxBytes ? Math.min(opts.maxBytes, this.config.limits.maxFileSizeBytes) : this.config.limits.maxFileSizeBytes;
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
      maxResults: Math.min(opts?.maxResults ?? this.config.search.maxResults, this.config.limits.maxSearchResults),
      maxFileSizeBytes: this.config.search.maxFileSizeBytes,
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
