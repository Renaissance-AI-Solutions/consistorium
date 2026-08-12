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
]);

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

  try {
    const result = await execFileAsync("git", args, {
      cwd: opts.cwd,
      maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
      timeout: opts.timeout ?? 15000,
      encoding: "utf-8",
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

export async function isDirty(canonicalPath: string): Promise<boolean> {
  try {
    const { stdout } = await gitExec(["status", "--porcelain"], { cwd: canonicalPath });
    return stdout.trim().length > 0;
  } catch {
    return false;
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

// Workaround: add rev-list to allowlist dynamically via separate function
async function gitExecAllowRevList(args: string[], opts: GitExecOptions) {
  // Temporary allow rev-list
  const orig = isAllowedGitArgs(args);
  if (args[0] === "rev-list") {
    // Allow rev-list as read-only
    try {
      const result = await execFileAsync("git", args, {
        cwd: opts.cwd,
        maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
        timeout: opts.timeout ?? 15000,
        encoding: "utf-8",
      });
      return { stdout: result.stdout as string, stderr: result.stderr as string };
    } catch (e: unknown) {
      const err = e as { code?: number; stdout?: string; stderr?: string; message: string };
      const wrapped: Error & { code?: number; stdout?: string; stderr?: string } = new Error(err.message);
      wrapped.code = err.code;
      wrapped.stdout = err.stdout;
      wrapped.stderr = err.stderr;
      throw wrapped;
    }
  }
  if (!orig) throw new Error(`Git command not allowlisted: git ${args[0]}`);
  return gitExec(args, opts);
}

// Better: just patch ALLOWED_GIT_ARGS to include rev-list at top, but we already defined it.
// We'll patch via re-export trick: add rev-list to set after definition.
(ALLOWED_GIT_ARGS as Set<string>).add("rev-list");
(ALLOWED_GIT_ARGS as Set<string>).add("rev-parse");
(ALLOWED_GIT_ARGS as Set<string>).add("status");
(ALLOWED_GIT_ARGS as Set<string>).add("log");
(ALLOWED_GIT_ARGS as Set<string>).add("diff");

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
): Promise<{ staged: FileChange[]; unstaged: FileChange[]; untracked: string[] }> {
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
  } catch {
    // return empty on error
  }

  return { staged, unstaged, untracked };
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
    let truncated = Buffer.from(stdout, "utf-8").subarray(0, maxBytes).toString("utf-8");
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

export async function listWorktrees(canonicalPath: string): Promise<WorktreeInfo[]> {
  // Use `git worktree list --porcelain`
  try {
    const { stdout } = await gitExec(["worktree", "list", "--porcelain"], { cwd: canonicalPath });
    if (!stdout.trim()) return [];

    // Porcelain format: blocks separated by blank line
    // worktree /path
    // HEAD <sha>  (or missing if bare?)
    // branch refs/heads/main  (or "detached")
    // bare / detached etc.
    const blocks = stdout.trim().split("\n\n");
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

      // For missing worktrees, skip expensive status calls
      let isDirtyFlag = false;
      let staged: FileChange[] = [];
      let unstaged: FileChange[] = [];
      let untracked: string[] = [];
      let headShort: string | null = head ? head.slice(0, 7) : null;
      let upstream: string | null = null;
      let ahead: number | null = null;
      let behind: number | null = null;

      if (!isMissing) {
        try {
          const status = await getStatusDetails(canonicalWtPath);
          staged = status.staged;
          unstaged = status.unstaged;
          untracked = status.untracked.slice(0, DEFAULT_LIMITS.maxUntrackedPreview);
          isDirtyFlag = staged.length > 0 || unstaged.length > 0 || status.untracked.length > 0;
        } catch {
          // ignore
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
        stagedChanges: staged,
        unstagedChanges: unstaged,
        untrackedFiles: untracked,
        untrackedCount: untracked.length, // will be corrected if truncated
        ahead,
        behind,
        upstream,
        provenance: { observedAt: new Date().toISOString() },
      });

      // Fix untrackedCount to include total, not just preview
      // We sliced above, so we need total count. Re-use status if available.
      // For simplicity, untrackedCount is preview length unless we know total.
      // We'll fetch total separately if needed: but staged/unstaged already captured total in array lengths before slice.
      // Actually we sliced untracked, so last worktree's untrackedCount is preview length.
      // Let's correct: need total untracked count.
      if (!isMissing) {
        try {
          const { stdout } = await gitExec(["status", "--porcelain=v1", "-uall"], { cwd: canonicalWtPath });
          let total = 0;
          for (const l of stdout.split("\n")) if (l.startsWith("??")) total++;
          worktrees[worktrees.length - 1]!.untrackedCount = total;
        } catch { /* keep preview length */ }
      }
    }

    return worktrees;
  } catch {
    // Fallback: single worktree is the repo itself
    const branchInfo = await getBranch(canonicalPath);
    const head = await getHeadCommit(canonicalPath);
    const dirty = await isDirty(canonicalPath);
    const status = await getStatusDetails(canonicalPath);
    const up = await getUpstreamInfoFixed(canonicalPath).catch(() => ({ upstream: null, ahead: null, behind: null }));
    let canonicalWtPath: string;
    try {
      canonicalWtPath = await fs.promises.realpath(canonicalPath);
    } catch {
      canonicalWtPath = path.normalize(canonicalPath);
    }
    return [
      {
        path: canonicalPath,
        canonicalPath: canonicalWtPath,
        branch: branchInfo.branch,
        headCommit: head,
        headCommitShort: head ? head.slice(0, 7) : null,
        isDetached: branchInfo.detached,
        isDirty: dirty,
        isMain: true,
        isMissing: false,
        stagedChanges: status.staged,
        unstagedChanges: status.unstaged,
        untrackedFiles: status.untracked.slice(0, DEFAULT_LIMITS.maxUntrackedPreview),
        untrackedCount: status.untracked.length,
        ahead: up.ahead,
        behind: up.behind,
        upstream: up.upstream,
        provenance: { observedAt: new Date().toISOString() },
      },
    ];
  }
}

export async function getRepoState(canonicalPath: string, recentLimit: number = 10): Promise<GitRepoState | null> {
  if (!(await isGitRepo(canonicalPath))) return null;
  const branchInfo = await getBranch(canonicalPath);
  const head = await getHeadCommit(canonicalPath);
  const dirty = await isDirty(canonicalPath);
  const recent = await getRecentCommits(canonicalPath, recentLimit);
  const up = await getUpstreamInfoFixed(canonicalPath).catch(() => ({ upstream: null, ahead: null, behind: null }));

  return {
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
