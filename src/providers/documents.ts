/**
 * Project context document provider — discovers/searches/reads allowlisted docs.
 *
 * Patterns are minimatch globs relative to project root.
 * Discovery respects security policy (denied files, binary, size).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";
import type { ContextDocSummary, ContextDocContent } from "../core/types.js";
import { DEFAULT_LIMITS } from "../core/types.js";
import { isDeniedByPolicy, isBinaryPath, type SecurityPolicy } from "../core/security.js";
import type { ResolvedProject } from "../core/types.js";

const GLOB_MAGIC = /[*?[\]{}!+@()]/;
const SKIP_DIRS = new Set([".git", "node_modules", ".ssh", ".aws", ".gnupg"]);

interface ScanBudget {
  remaining: number;
}

function hasMagic(value: string): boolean {
  return GLOB_MAGIC.test(value);
}

/**
 * Leading segments of a glob that contain no magic, so traversal can start at
 * the only subtree the pattern is able to match ("docs/**\/*.md" -> "docs").
 */
function staticPrefix(pattern: string): string {
  const parts = pattern.split(path.posix.sep);
  const prefix: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (hasMagic(part)) break;
    prefix.push(part);
  }
  return prefix.join(path.posix.sep);
}

/**
 * Canonical path for one candidate file, or null when containment, policy,
 * or type checks reject it.
 */
async function acceptFile(
  full: string,
  canonProject: string,
  policy: SecurityPolicy | null
): Promise<string | null> {
  let canonicalFile: string;
  try {
    canonicalFile = await fs.promises.realpath(full);
  } catch {
    return null;
  }
  const normFile = path.normalize(canonicalFile).replace(/\/+$/, "") || "/";
  const normProject = path.normalize(canonProject).replace(/\/+$/, "") || "/";
  if (normFile !== normProject && !normFile.startsWith(normProject + path.sep)) return null;
  if (policy && !policy.isInsideAllowedRoot(normFile)) return null;
  if (isDeniedByPolicy(normFile, canonProject).denied) return null;
  if (isBinaryPath(normFile)) return null;
  return canonicalFile;
}

/**
 * Yield canonical file paths under `dir`. Streaming rather than array-returning:
 * a directory holding more entries than V8 accepts as spread arguments used to
 * overflow the stack when subtree results were pushed into a parent array.
 */
async function* walkFiles(
  dir: string,
  canonProject: string,
  policy: SecurityPolicy | null,
  visited: Set<string>,
  budget: ScanBudget
): AsyncGenerator<string> {
  let canonicalDir: string;
  try {
    canonicalDir = await fs.promises.realpath(dir);
  } catch {
    return;
  }
  // Prevent symlink loops: track visited canonical dirs.
  if (visited.has(canonicalDir)) return;
  visited.add(canonicalDir);

  // Containment: dir must be inside projectRoot.
  if (canonicalDir !== canonProject && !canonicalDir.startsWith(canonProject + path.sep)) return;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const ent of entries) {
    if (budget.remaining <= 0) return;
    budget.remaining -= 1;
    const full = path.join(dir, ent.name);

    let isDir = ent.isDirectory();
    if (ent.isSymbolicLink()) {
      try {
        isDir = (await fs.promises.stat(full)).isDirectory();
      } catch {
        continue;
      }
    }

    if (isDir) {
      if (SKIP_DIRS.has(ent.name)) continue;
      if (ent.isSymbolicLink()) {
        // Symlinked directory: only follow it when it stays inside the project.
        try {
          const real = await fs.promises.realpath(full);
          const normReal = path.normalize(real).replace(/\/+$/, "") || "/";
          if (normReal !== canonProject && !normReal.startsWith(canonProject + path.sep)) continue;
          if (isDeniedByPolicy(normReal, canonProject).denied) continue;
        } catch {
          continue;
        }
      }
      yield* walkFiles(full, canonProject, policy, visited, budget);
    } else if (ent.isFile() || ent.isSymbolicLink()) {
      const accepted = await acceptFile(full, canonProject, policy);
      if (accepted) yield accepted;
    }
  }
}

/**
 * Discover context documents matching configured patterns.
 *
 * Patterns are root-relative. A pattern with no glob magic names exactly one
 * file and is resolved by a direct stat; a glob is walked only from its static
 * prefix. Neither form scans unrelated subtrees, so a repository with hundreds
 * of thousands of data files still resolves its handful of documents.
 */
export async function discoverContextDocuments(
  project: ResolvedProject,
  policy: SecurityPolicy | null,
  opts?: { maxDocs?: number; maxScanEntries?: number }
): Promise<ContextDocSummary[]> {
  const maxDocs = opts?.maxDocs ?? DEFAULT_LIMITS.maxContextDocsPerProject;
  const patterns = project.contextPatterns ?? [];
  if (patterns.length === 0) return [];

  const canonProject = await fs.promises
    .realpath(project.canonicalPath)
    .catch(() => path.normalize(project.canonicalPath));
  const budget: ScanBudget = {
    remaining: opts?.maxScanEntries ?? DEFAULT_LIMITS.maxContextScanEntries,
  };

  // canonical absolute path -> the pattern that first matched it
  const matches = new Map<string, string>();

  for (const pattern of patterns.filter((pat) => !hasMagic(pat))) {
    const full = path.resolve(canonProject, pattern.split(path.posix.sep).join(path.sep));
    const accepted = await acceptFile(full, canonProject, policy);
    if (accepted && !matches.has(accepted)) matches.set(accepted, pattern);
  }

  const byPrefix = new Map<string, string[]>();
  for (const pattern of patterns.filter(hasMagic)) {
    const prefix = staticPrefix(pattern);
    const group = byPrefix.get(prefix);
    if (group) group.push(pattern);
    else byPrefix.set(prefix, [pattern]);
  }

  for (const [prefix, group] of byPrefix) {
    if (matches.size >= maxDocs) break;
    const startDir = prefix
      ? path.resolve(canonProject, prefix.split(path.posix.sep).join(path.sep))
      : canonProject;
    const visited = new Set<string>();
    for await (const absPath of walkFiles(startDir, canonProject, policy, visited, budget)) {
      if (matches.size >= maxDocs) break;
      if (matches.has(absPath)) continue;
      const relPosix = path.relative(canonProject, absPath).split(path.sep).join(path.posix.sep);
      const matched = group.find((pattern) => minimatch(relPosix, pattern, { dot: true }));
      if (matched) matches.set(absPath, matched);
    }
  }

  const summaries: ContextDocSummary[] = [];
  for (const [absPath, matched] of matches) {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    summaries.push({
      path: path.relative(canonProject, absPath).split(path.sep).join(path.posix.sep),
      canonicalPath: absPath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      matchesPattern: matched,
    });

    if (summaries.length >= maxDocs) break;
  }

  // Sort by modifiedAt desc
  summaries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return summaries;
}

/**
 * Read a context document by relative path, enforcing policy & limits.
 */
export async function readContextDocument(
  project: ResolvedProject,
  policy: SecurityPolicy | null,
  requestedPath: string, // relative or absolute
  opts?: { maxBytes?: number }
): Promise<ContextDocContent> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_LIMITS.maxFileSizeBytes;

  // Resolve requestedPath to canonical inside project
  let absolute: string;
  if (path.isAbsolute(requestedPath)) {
    absolute = path.normalize(requestedPath);
  } else {
    // Strip leading ./ if present
    const clean = requestedPath.replace(/^\.\//, "");
    absolute = path.normalize(path.join(project.canonicalPath, clean));
  }

  // Lexical containment check before realpath existence — catches ../ escapes even for missing files
  const lexical = path.normalize(absolute).replace(/\/+$/, "") || "/";
  let canonProjectLex: string;
  try {
    canonProjectLex = await fs.promises.realpath(project.canonicalPath);
  } catch {
    canonProjectLex = path.normalize(project.canonicalPath);
  }
  canonProjectLex = canonProjectLex.replace(/\/+$/, "") || "/";
  if (lexical !== canonProjectLex && !lexical.startsWith(canonProjectLex + path.sep)) {
    throw Object.assign(new Error(`Path escapes project: ${requestedPath}`), { code: "PATH_ESCAPE" });
  }
  if (policy && !policy.isInsideAllowedRoot(lexical)) {
    // For non-existent files, lexical check is sufficient to deny traversal
    // We won't throw here immediately for policy, because real canonical may be inside even if lexical is outside due to symlink?
    // But for traversal, lexical already caught project escape; for policy we defer to canonical below.
  }

  // Canonicalize (symlink-aware)
  let canonical: string;
  try {
    canonical = await fs.promises.realpath(absolute);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      // If lexical already escaped, we already threw. Otherwise, it's genuinely not found.
      throw Object.assign(new Error(`Document not found: ${requestedPath}`), { code: "NOT_FOUND" });
    }
    throw e;
  }
  canonical = path.normalize(canonical).replace(/\/+$/, "") || "/";

  // Must be inside project
  let canonProject: string;
  try {
    canonProject = await fs.promises.realpath(project.canonicalPath);
  } catch {
    canonProject = path.normalize(project.canonicalPath);
  }
  canonProject = canonProject.replace(/\/+$/, "") || "/";

  if (canonical !== canonProject && !canonical.startsWith(canonProject + path.sep)) {
    throw Object.assign(new Error(`Path escapes project: ${requestedPath}`), { code: "PATH_ESCAPE" });
  }

  // Must also be inside allowed roots if policy present
  if (policy && !policy.isInsideAllowedRoot(canonical)) {
    throw Object.assign(new Error(`Path escapes allowed roots: ${requestedPath}`), { code: "PATH_ESCAPE" });
  }

  // Check allowed patterns: file must match at least one context pattern
  const relPosix = path.relative(canonProject, canonical).split(path.sep).join(path.posix.sep);
  let matches = false;
  for (const pat of project.contextPatterns) {
    const patPosix = pat.split(path.sep).join(path.posix.sep);
    if (minimatch(relPosix, patPosix, { dot: true }) || minimatch(path.posix.basename(relPosix), patPosix, { dot: true })) {
      matches = true;
      break;
    }
  }
  if (!matches) {
    throw Object.assign(
      new Error(`Document not allowlisted by project context patterns: ${requestedPath}`),
      { code: "NOT_ALLOWLISTED" }
    );
  }

  // Denied policy (secrets, binary)
  const denied = isDeniedByPolicy(canonical, canonProject);
  if (denied.denied) {
    throw Object.assign(new Error(`Denied by security policy: ${denied.reason}`), { code: "DENIED" });
  }

  // Stat + size limit
  const stat = await fs.promises.stat(canonical);
  if (!stat.isFile()) {
    throw Object.assign(new Error(`Not a file: ${requestedPath}`), { code: "NOT_FILE" });
  }
  if (isBinaryPath(canonical)) {
    throw Object.assign(new Error(`Binary file denied: ${requestedPath}`), { code: "BINARY" });
  }

  let truncated = false;
  let content: string;
  if (stat.size > maxBytes) {
    // Read truncated
    const fd = await fs.promises.open(canonical, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await fd.read(buf, 0, maxBytes, 0);
      content = buf.subarray(0, bytesRead).toString("utf-8") + "\n... [truncated]";
      truncated = true;
    } finally {
      await fd.close();
    }
  } else {
    content = await fs.promises.readFile(canonical, "utf-8");
  }

  return {
    path: relPosix,
    canonicalPath: canonical,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    content,
    truncated,
    provenance: {
      observedAt: new Date().toISOString(),
      projectName: project.name,
      projectPath: project.canonicalPath,
    },
  };
}
