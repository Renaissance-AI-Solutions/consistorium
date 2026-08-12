/**
 * Git provider — read-only git inspection via allowlisted spawn/execFile.
 *
 * Never uses shell. All commands are execFile with arg arrays.
 * Only read-only commands are allowlisted.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CommitSummary, ChangedFileStat, WorktreeInfo, GitRepoState, FileChange } from "../core/types.js";
import { DEFAULT_LIMITS } from "../core/types.js";

const execFileAsync = promisify(execFile);
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

// Allowlisted git subcommands (read-only)
const ALLOWED_GIT_ARGS = new Set([
  "rev-parse",
  "status",
  "branch",
  "log",
  "diff",
  "show",
  "worktree",
  "merge-base",
  "for-each-ref",
  "ls-files",
  "remote",
  "config",
  "rev-list",
]);

const HARDENED_GIT_OPTIONS = [
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", `core.hooksPath=${NULL_DEVICE}`,
  "-c", "diff.external=",
  "--no-optional-locks",
];

function hardenedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Do not inherit Git's config, object, helper, pager, SSH, or trace knobs
  // from the host. The server only needs the repository selected by cwd.
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
  };
}

function isAllowedGitArgs(args: string[]): boolean {
  if (args.length === 0) return false;
  return ALLOWED_GIT_ARGS.has(args[0]!);
}

export interface GitExecOptions {
  cwd: string;
  maxBuffer?: number;
  timeout?: number;
}

/**
 * Safe git exec — no shell, arg array only.
 */
async function gitExec(args: string[], opts: GitExecOptions): Promise<{ stdout: string; stderr: string }> {
  if (!isAllowedGitArgs(args)) {
    throw new Error(`Git command not allowlisted: git ${args[0]}`);
  }
  // Additional guard: deny mutation flags even on allowed subcommands
  const denyFlags = [
    "--hard", "--soft", "--mixed", // reset
    // No checkout, commit, push, merge, rebase etc. are even in allowed set
  ];
  for (const a of args) {
    if (denyFlags.includes(a)) throw new Error(`Denied git flag: ${a}`);
  }

  const commandArgs = args[0] === "diff"
    ? [args[0], "--no-ext-diff", "--no-textconv", ...args.slice(1)]
    : args;
  const hardenedArgs = [...HARDENED_GIT_OPTIONS, ...commandArgs];
  try {
    const result = await execFileAsync("git", hardenedArgs, {
      cwd: opts.cwd,
      maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
      timeout: opts.timeout ?? 15000,
      encoding: "utf-8",
      env: hardenedGitEnv(),
    });
    return { stdout: result.stdout as string, stderr: result.stderr as string };
  } catch (e: unknown) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message: string };
    // Re-throw with stdout/stderr for callers that care
    const wrapped: Error & { code?: number; stdout?: string; stderr?: string } = new Error(err.message);
    wrapped.code = err.code;
    wrapped.stdout = err.stdout;
    wrapped.stderr = err.stderr;
    throw wrapped;
  }
}

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

export async function isGitRepo(canonicalPath: string): Promise<boolean> {
  try {
    const { stdout } = await gitExec(["rev-parse", "--is-inside-work-tree"], { cwd: canonicalPath });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function getGitRoot(canonicalPath: string): Promise<string | null> {
  try {
    const { stdout } = await gitExec(["rev-parse", "--show-toplevel"], { cwd: canonicalPath });
    const out = stdout.trim();
    if (!out) return null;
    try {
      return await fs.promises.realpath(out);
    } catch {
      return path.normalize(out);
    }
  } catch {
    return null;
  }
}

export async function getHeadCommit(canonicalPath: string): Promise<string | null> {
  try {
    const { stdout } = await gitExec(["rev-parse", "HEAD"], { cwd: canonicalPath });
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

export async function getBranch(canonicalPath: string): Promise<{ branch: string | null; detached: boolean }> {
  try {
    const { stdout } = await gitExec(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: canonicalPath });
    const name = stdout.trim();
    if (name === "HEAD") return { branch: null, detached: true };
    return { branch: name, detached: false };
  } catch {
    return { branch: null, detached: false };
  }
}

export async function isDirty(canonicalPath: string): Promise<boolean | null> {
  try {
    const { stdout } = await gitExec(["status", "--porcelain"], { cwd: canonicalPath });
    return stdout.trim().length > 0;
  } catch {
    return null;
  }
}

export async function getUpstreamInfo(
  canonicalPath: string
): Promise<{ upstream: string | null; ahead: number | null; behind: number | null }> {
  try {
    // Get upstream ref
    const { stdout: upstreamOut } = await gitExec(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: canonicalPath,
    });
    const upstream = upstreamOut.trim();
    if (!upstream) return { upstream: null, ahead: null, behind: null };

    // ahead/behind via rev-list --left-right --count HEAD...@{u}
    const { stdout: countOut } = await gitExec(["rev-list", "--left-right", "--count", `HEAD...@{u}`], {
      cwd: canonicalPath,
    });
    // But rev-list not in allowlist? Add it.
    // Actually rev-list is safe read-only; we allow it via args check above if we add it.
    // Instead use "log" alternative or just add rev-list to allowlist.
    // Fallback: use for-each-ref? Easier: add rev-list to allowlist.
    // For now, if we got here via rev-parse, try rev-list.
    const parts = countOut.trim().split(/\s+/);
    const ahead = parseInt(parts[0] ?? "0", 10);
    const behind = parseInt(parts[1] ?? "0", 10);
    return {
      upstream,
      ahead: Number.isNaN(ahead) ? null : ahead,
      behind: Number.isNaN(behind) ? null : behind,
    };
  } catch {
    return { upstream: null, ahead: null, behind: null };
  }
}

// Correct upstream info using rev-list now that it's allowed
export async function getUpstreamInfoFixed(
  canonicalPath: string
): Promise<{ upstream: string | null; ahead: number | null; behind: number | null }> {
  let upstream: string | null = null;
  try {
    const { stdout } = await gitExec(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: canonicalPath,
    });
    upstream = stdout.trim() || null;
  } catch {
    return { upstream: null, ahead: null, behind: null };
  }
  if (!upstream) return { upstream: null, ahead: null, behind: null };
  try {
    const { stdout } = await gitExec(["rev-list", "--left-right", "--count", `HEAD...@{u}`], {
      cwd: canonicalPath,
    });
    const parts = stdout.trim().split(/\s+/);
    const ahead = parseInt(parts[0] ?? "0", 10);
    const behind = parseInt(parts[1] ?? "0", 10);
    return {
      upstream,
      ahead: Number.isNaN(ahead) ? null : ahead,
      behind: Number.isNaN(behind) ? null : behind,
    };
  } catch {
    return { upstream, ahead: null, behind: null };
  }
}

// ---------------------------------------------------------------------------
// Status parsing
// ---------------------------------------------------------------------------

export async function getStatusDetails(
  canonicalPath: string
): Promise<{ staged: FileChange[]; unstaged: FileChange[]; untracked: string[]; available: boolean; error?: string }> {
  const staged: FileChange[] = [];
  const unstaged: FileChange[] = [];
  const untracked: string[] = [];

  try {
    const { stdout } = await gitExec(["status", "--porcelain=v1", "-uall"], { cwd: canonicalPath });
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      // Format: XY<space>path  (or XY<space>path -> orig for renames)
      // X = staged, Y = unstaged
      if (line.startsWith("??")) {
        const p = line.slice(3).trim();
        untracked.push(p);
        continue;
      }
      if (line.length < 3) continue;
      const x = line[0]!;
      const y = line[1]!;
      // Extract path (handle renames: "R  old -> new" — we want new)
      let filePath = line.slice(3);
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ").pop()!.trim();
      } else {
        filePath = filePath.trim();
      }
      if (x !== " " && x !== "?" && x !== "!") {
        staged.push({ path: filePath, status: x, staged: true });
      }
      if (y !== " " && y !== "?" && y !== "!") {
        unstaged.push({ path: filePath, status: y, staged: false });
      }
    }
    return { staged, unstaged, untracked, available: true };
  } catch (error) {
    // Empty changes are not authoritative when status itself failed.
    return { staged: [], unstaged: [], untracked: [], available: false, error: observationError(error) };
  }
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export async function getRecentCommits(
  canonicalPath: string,
  limit: number = DEFAULT_LIMITS.maxCommitsDefault
): Promise<CommitSummary[]> {
  const n = Math.min(Math.max(1, limit), DEFAULT_LIMITS.maxCommitsMax);
  try {
    // Use log with custom format: sha|short|subject|author|email|date|parents
    // Use %x1f as field separator, %x1e as record separator
    const format = "%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%P%x1e";
    const { stdout } = await gitExec(["log", `--max-count=${n}`, `--pretty=format:${format}`], {
      cwd: canonicalPath,
    });
    if (!stdout.trim()) return [];
    const records = stdout.split("\x1e").filter((r) => r.trim().length > 0);
    return records.map((rec) => {
      const parts = rec.split("\x1f");
      const [sha = "", shortSha = "", subject = "", author = "", authorEmail = "", date = "", parentsRaw = ""] = parts;
      const parents = parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [];
      return {
        sha: sha.trim(),
        shortSha: shortSha.trim(),
        subject: subject.trim(),
        author: author.trim(),
        authorEmail: authorEmail.trim(),
        date: date.trim(),
        parents,
      };
    });
  } catch {
    return [];
  }
}

export async function getCommitsBetween(
  canonicalPath: string,
  base: string,
  target: string,
  limit = DEFAULT_LIMITS.maxCommitsMax,
): Promise<CommitSummary[]> {
  const n = Math.min(Math.max(1, limit), DEFAULT_LIMITS.maxCommitsMax);
  const format = "%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%P%x1e";
  try {
    const { stdout } = await gitExec(["log", `--max-count=${n}`, `--pretty=format:${format}`, `${base}..${target}`], {
      cwd: canonicalPath,
      maxBuffer: 5 * 1024 * 1024,
    });
    if (!stdout.trim()) return [];
    return stdout.split("\x1e").filter((record) => record.trim().length > 0).map((record) => {
      const parts = record.split("\x1f");
      const [sha = "", shortSha = "", subject = "", author = "", authorEmail = "", date = "", parentsRaw = ""] = parts;
      return {
        sha: sha.trim(),
        shortSha: shortSha.trim(),
        subject: subject.trim(),
        author: author.trim(),
        authorEmail: authorEmail.trim(),
        date: date.trim(),
        parents: parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [],
      };
    });
  } catch {
    return [];
  }
}

export async function getDiffStat(
  canonicalPath: string,
  base = "HEAD",
  target?: string
): Promise<string> {
  try {
    const args = target ? ["diff", "--stat", `${base}..${target}`] : ["diff", "--stat", base];
    // Also handle HEAD with no commits: diff without base
    const { stdout } = await gitExec(args, { cwd: canonicalPath });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function getChangedFileStats(
  canonicalPath: string,
  base = "HEAD",
  target?: string
): Promise<ChangedFileStat[]> {
  try {
    const range = target ? `${base}..${target}` : base;
    // Use diff --numstat for additions/deletions, and --name-status for status
    const { stdout: numstat } = await gitExec(["diff", "--numstat", range], { cwd: canonicalPath });
    const { stdout: namestat } = await gitExec(["diff", "--name-status", range], { cwd: canonicalPath });

    const statusMap = new Map<string, string>();
    for (const line of namestat.split("\n")) {
      if (!line.trim()) continue;
      const [status, ...rest] = line.split("\t");
      let file = rest.join("\t").trim();
      // Handle renames: "R100\told\tnew"
      if (file.includes("\t")) file = file.split("\t").pop()!.trim();
      if (status && file) statusMap.set(file, status[0]!);
    }

    const results: ChangedFileStat[] = [];
    for (const line of numstat.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const [addRaw, delRaw, fileRaw] = parts;
      let file = fileRaw.trim();
      if (file.includes("\t")) file = file.split("\t").pop()!.trim();
      // Handle rename arrow in some git versions
      if (file.includes(" => ")) {
        // "old => new" with braces
        const m = file.match(/\{.* => (.*)\}/);
        if (m) file = m[1]!.trim();
        else file = file.split(" => ").pop()!.trim();
      }
      const additions = addRaw === "-" ? 0 : parseInt(addRaw ?? "0", 10) || 0;
      const deletions = delRaw === "-" ? 0 : parseInt(delRaw ?? "0", 10) || 0;
      results.push({
        path: file,
        additions,
        deletions,
        status: statusMap.get(file) ?? "M",
      });
    }
    return results;
  } catch {
    return [];
  }
}

export async function getMergeBase(canonicalPath: string, a: string, b: string): Promise<string | null> {
  try {
    const { stdout } = await gitExec(["merge-base", a, b], { cwd: canonicalPath });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function getAheadBehind(
  canonicalPath: string,
  a: string,
  b: string
): Promise<{ ahead: number | null; behind: number | null }> {
  try {
    const { stdout } = await gitExec(["rev-list", "--left-right", "--count", `${a}...${b}`], {
      cwd: canonicalPath,
    });
    const parts = stdout.trim().split(/\s+/);
    const ahead = parseInt(parts[0] ?? "0", 10);
    const behind = parseInt(parts[1] ?? "0", 10);
    return {
      ahead: Number.isNaN(ahead) ? null : ahead,
      behind: Number.isNaN(behind) ? null : behind,
    };
  } catch {
    return { ahead: null, behind: null };
  }
}

export async function getBoundedDiff(
  canonicalPath: string,
  args: string[],
  maxBytes: number
): Promise<{ diff: string | null; truncated: boolean }> {
  try {
    const { stdout } = await gitExec(args, { cwd: canonicalPath, maxBuffer: Math.max(maxBytes * 2, 1024 * 1024) });
    if (Buffer.byteLength(stdout, "utf-8") <= maxBytes) {
      return { diff: stdout, truncated: false };
    }
    // Truncate on char boundary
    const truncated = Buffer.from(stdout, "utf-8").subarray(0, maxBytes).toString("utf-8");
    // Avoid cutting in middle of multi-byte char by re-encoding
    return { diff: truncated + "\n... [truncated]", truncated: true };
  } catch (e) {
    // If git diff fails (e.g., no commits), return null
    return { diff: null, truncated: false };
  }
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function listWorktrees(
  canonicalPath: string,
  allowedRoot?: string,
  maxWorktrees: number = DEFAULT_LIMITS.maxWorktrees
): Promise<WorktreeInfo[]> {
  const inspectionRoot = await fs.promises.realpath(allowedRoot ?? canonicalPath).catch(() => path.normalize(allowedRoot ?? canonicalPath));
  // Use `git worktree list --porcelain`
  try {
    const { stdout } = await gitExec(["worktree", "list", "--porcelain"], { cwd: canonicalPath });
    if (!stdout.trim()) return [];

    // Porcelain format: blocks separated by blank line
    // worktree /path
    // HEAD <sha>  (or missing if bare?)
    // branch refs/heads/main  (or "detached")
    // bare / detached etc.
    const worktreeLimit = Number.isInteger(maxWorktrees)
      ? Math.max(1, Math.min(maxWorktrees, DEFAULT_LIMITS.maxWorktrees))
      : DEFAULT_LIMITS.maxWorktrees;
    const blocks = stdout.trim().split("\n\n").slice(0, worktreeLimit);
    const worktrees: WorktreeInfo[] = [];

    // Determine main worktree path (first entry is main)
    let mainPath: string | null = null;

    for (const block of blocks) {
      const lines = block.split("\n");
      let wtPath: string | null = null;
      let head: string | null = null;
      let branchRef: string | null = null;
      let isBare = false;
      let isDetached = false;

      for (const line of lines) {
        if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length).trim();
        else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
        else if (line.startsWith("branch ")) branchRef = line.slice("branch ".length).trim();
        else if (line === "bare") isBare = true;
        else if (line === "detached") isDetached = true;
      }

      if (!wtPath || isBare) continue;
      if (!mainPath) mainPath = wtPath;

      // Derive branch name
      let branch: string | null = null;
      if (branchRef) {
        branch = branchRef.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : branchRef;
      }

      let canonicalWtPath: string;
      try {
        canonicalWtPath = await fs.promises.realpath(wtPath);
      } catch {
        canonicalWtPath = path.normalize(wtPath);
      }
      canonicalWtPath = canonicalWtPath.replace(/\/+$/, "") || "/";

      // Check existence
      let isMissing = false;
      try {
        await fs.promises.stat(canonicalWtPath);
      } catch {
        isMissing = true;
      }

      const inspectable = isWithinPath(inspectionRoot, canonicalWtPath);

      // Missing and externally linked worktrees are metadata-only. In
      // particular, never run status/upstream commands against an external
      // path unless it is inside the explicitly configured project root.
      let isDirtyFlag: boolean | null = null;
      let inspection: WorktreeInfo["inspection"] = inspectable && !isMissing ? "available" : isMissing ? "unavailable" : "limited";
      let unavailableReason = isMissing
        ? "worktree path is missing"
        : inspectable
          ? undefined
          : "linked worktree is outside the explicitly configured project root; metadata only";
      let staged: FileChange[] = [];
      let unstaged: FileChange[] = [];
      let untracked: string[] = [];
      const headShort: string | null = head ? head.slice(0, 7) : null;
      let upstream: string | null = null;
      let ahead: number | null = null;
      let behind: number | null = null;
      let totalUntracked = 0;

      if (!isMissing && inspectable) {
        try {
          const status = await getStatusDetails(canonicalWtPath);
          if (status.available) {
            staged = status.staged;
            unstaged = status.unstaged;
            untracked = status.untracked.slice(0, DEFAULT_LIMITS.maxUntrackedPreview);
            totalUntracked = status.untracked.length;
            isDirtyFlag = staged.length > 0 || unstaged.length > 0 || totalUntracked > 0;
          } else {
            inspection = "unavailable";
            unavailableReason = status.error ?? "git status unavailable";
          }
        } catch {
          inspection = "unavailable";
          unavailableReason = "git status unavailable";
        }
        try {
          const up = await getUpstreamInfoFixed(canonicalWtPath);
          upstream = up.upstream;
          ahead = up.ahead;
          behind = up.behind;
        } catch { /* ignore */ }
      }

      const isMain = wtPath === mainPath;

      worktrees.push({
        path: wtPath,
        canonicalPath: canonicalWtPath,
        branch,
        headCommit: head && head !== "(null)" ? head : null,
        headCommitShort: headShort && headShort !== "(null" ? headShort : null,
        isDetached,
        isDirty: isDirtyFlag,
        isMain,
        isMissing,
        inspection,
        unavailableReason,
        stagedChanges: staged,
        unstagedChanges: unstaged,
        untrackedFiles: untracked,
        untrackedCount: totalUntracked,
        ahead,
        behind,
        upstream,
        provenance: { observedAt: new Date().toISOString() },
      });

    }

    return worktrees;
  } catch (listError) {
    // If worktree metadata cannot be listed, return one explicit observation
    // rather than synthesizing a clean/empty worktree from best-effort calls.
    const observed = await observeRepositoryState(canonicalPath, allowedRoot);
    const canonicalWtPath = observed.worktreePath;
    return [{
      path: canonicalPath,
      canonicalPath: canonicalWtPath,
      branch: observed.branch,
      headCommit: observed.head,
      headCommitShort: observed.head ? observed.head.slice(0, 7) : null,
      isDetached: observed.isDetached === true,
      isDirty: observed.availability === "available" ? observed.isDirty : null,
      isMain: true,
      isMissing: false,
      inspection: observed.availability === "available" ? "limited" : "unavailable",
      unavailableReason: observed.availability === "available"
        ? `worktree metadata unavailable: ${observationError(listError)}`
        : observed.error ?? "canonical Git observation unavailable",
      stagedChanges: [],
      unstagedChanges: [],
      untrackedFiles: [],
      untrackedCount: 0,
      ahead: null,
      behind: null,
      upstream: null,
      provenance: { observedAt: observed.observedAt },
    }];
  }
}

export interface RepositoryObservation {
  availability: "available" | "not_git" | "unavailable";
  observedAt: string;
  repositoryPath: string | null;
  worktreePath: string;
  branch: string | null;
  head: string | null;
  isDetached?: boolean | null;
  isDirty: boolean | null;
  error?: string;
}

function normalizedRealpath(value: string): string {
  return path.normalize(value).replace(/\\+$/, "") || path.parse(value).root;
}

function observationError(error: unknown): string {
  const candidate = error as { stderr?: string; message?: string };
  return (candidate.stderr || candidate.message || String(error)).trim().slice(0, 500);
}

function isNotGitError(error: unknown): boolean {
  const detail = observationError(error).toLowerCase();
  return detail.includes("not a git repository") || detail.includes("cannot change to") || detail.includes("does not appear to be a git repository");
}

/**
 * Canonical, all-or-unavailable observation used by durable handoffs.
 * Individual legacy helpers intentionally remain best-effort for compatibility,
 * but this function never turns a failed command into a clean/empty state.
 */
export async function observeRepositoryState(worktreePath: string, configuredRoot?: string): Promise<RepositoryObservation> {
  const requested = await fs.promises.realpath(worktreePath).catch(() => normalizedRealpath(worktreePath));
  const resolvedConfiguredRoot = configuredRoot
    ? await fs.promises.realpath(configuredRoot).catch(() => normalizedRealpath(configuredRoot))
    : undefined;
  const observedAt = new Date().toISOString();
  if (resolvedConfiguredRoot && !isWithinPath(resolvedConfiguredRoot, requested)) {
    return {
      availability: "unavailable",
      observedAt,
      repositoryPath: resolvedConfiguredRoot,
      worktreePath: requested,
      branch: null,
      head: null,
      isDirty: null,
      error: "worktree is outside the explicitly configured project root",
    };
  }

  try {
    const inside = (await gitExec(["rev-parse", "--is-inside-work-tree"], { cwd: requested })).stdout.trim();
    if (inside !== "true") {
      return {
        availability: "not_git",
        observedAt,
        repositoryPath: null,
        worktreePath: requested,
        branch: null,
        head: null,
        isDirty: null,
        error: "path is not a git worktree",
      };
    }

    const root = normalizedRealpath((await gitExec(["rev-parse", "--show-toplevel"], { cwd: requested })).stdout.trim());
    const branchRaw = (await gitExec(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: requested })).stdout.trim();
    const head = (await gitExec(["rev-parse", "HEAD"], { cwd: requested })).stdout.trim() || null;
    const status = (await gitExec(["status", "--porcelain=v1", "-uall"], { cwd: requested })).stdout;
    return {
      availability: "available",
      observedAt,
      repositoryPath: root,
      worktreePath: requested,
      branch: branchRaw === "HEAD" ? null : branchRaw || null,
      head,
      isDetached: branchRaw === "HEAD",
      isDirty: status.length > 0,
    };
  } catch (error) {
    return {
      availability: isNotGitError(error) ? "not_git" : "unavailable",
      observedAt,
      repositoryPath: resolvedConfiguredRoot ?? null,
      worktreePath: requested,
      branch: null,
      head: null,
      isDirty: null,
      error: observationError(error),
    };
  }
}

export async function getRepoState(canonicalPath: string, recentLimit: number = 10): Promise<GitRepoState | null> {
  const observed = await observeRepositoryState(canonicalPath);
  if (observed.availability !== "available") {
    return observed.availability === "not_git"
      ? null
      : {
          availability: observed.availability,
          error: observed.error,
          branch: null,
          headCommit: null,
          headCommitShort: null,
          isDetached: false,
          isDirty: null,
          ahead: null,
          behind: null,
          upstream: null,
          recentCommits: [],
        };
  }
  const branchInfo = { branch: observed.branch, detached: observed.isDetached === true };
  const head = observed.head;
  const dirty = observed.isDirty;
  const recent = await getRecentCommits(canonicalPath, recentLimit);
  const up = await getUpstreamInfoFixed(canonicalPath).catch(() => ({ upstream: null, ahead: null, behind: null }));

  return {
    availability: "available",
    branch: branchInfo.branch,
    headCommit: head,
    headCommitShort: head ? head.slice(0, 7) : null,
    isDetached: branchInfo.detached,
    isDirty: dirty,
    ahead: up.ahead,
    behind: up.behind,
    upstream: up.upstream,
    recentCommits: recent,
  };
}
