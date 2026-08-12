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

async function walk(
  dir: string,
  projectRoot: string,
  policy: SecurityPolicy | null,
  visited: Set<string>
): Promise<string[]> {
  const results: string[] = [];
  let canonicalDir: string;
  try {
    canonicalDir = await fs.promises.realpath(dir);
  } catch {
    return results;
  }
  // Prevent symlink loops: track visited canonical dirs
  if (visited.has(canonicalDir)) return results;
  visited.add(canonicalDir);

  // Containment: dir must be inside projectRoot
  if (policy) {
    try {
      const canonProject = await fs.promises.realpath(projectRoot).catch(() => path.normalize(projectRoot));
      if (!canonicalDir.startsWith(canonProject + path.sep) && canonicalDir !== canonProject) {
        // Allow if dir is projectRoot itself? Already checked outer.
        // If walk dir escaped via symlink, skip.
        return results;
      }
    } catch { /* ignore */ }
  }

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    let stat: fs.Stats | null = null;
    try {
      stat = await fs.promises.lstat(full);
    } catch {
      continue;
    }

    // Skip if symlink to outside? We'll check realpath containment below.

    if (ent.isDirectory() || (ent.isSymbolicLink() && stat.isDirectory?.())) {
      // For symlink dirs, we need to check realpath
      if (ent.isSymbolicLink()) {
        try {
          const real = await fs.promises.realpath(full);
          // Containment: must remain inside projectRoot
          const canonProject = await fs.promises.realpath(projectRoot).catch(() => path.normalize(projectRoot));
          const normReal = path.normalize(real).replace(/\/+$/, "") || "/";
          const normProject = path.normalize(canonProject).replace(/\/+$/, "") || "/";
          if (normReal !== normProject && !normReal.startsWith(normProject + path.sep)) {
            continue; // symlink escape — skip
          }
          // Also skip denied segments
          const denied = isDeniedByPolicy(normReal, canonProject);
          if (denied.denied) continue;
        } catch {
          continue;
        }
      }

      // Skip denied dirs: .git, node_modules, .ssh etc.
      const base = ent.name;
      if (base === ".git" || base === "node_modules" || base === ".ssh" || base === ".aws" || base === ".gnupg") {
        continue;
      }
      // Recurse
      const sub = await walk(full, projectRoot, policy, visited);
      results.push(...sub);
    } else if (ent.isFile() || ent.isSymbolicLink()) {
      // Resolve symlink files to canonical and check containment + denied
      let canonicalFile: string;
      try {
        canonicalFile = await fs.promises.realpath(full);
      } catch {
        continue;
      }
      const canonProject = await fs.promises.realpath(projectRoot).catch(() => path.normalize(projectRoot));
      const normFile = path.normalize(canonicalFile).replace(/\/+$/, "") || "/";
      const normProject = path.normalize(canonProject).replace(/\/+$/, "") || "/";
      if (normFile !== normProject && !normFile.startsWith(normProject + path.sep)) {
        continue; // symlink escape
      }
      // Also check if original path escapes via policy roots
      if (policy && !policy.isInsideAllowedRoot(normFile)) {
        continue;
      }

      // Apply denied policy
      const denied = isDeniedByPolicy(normFile, canonProject);
      if (denied.denied) continue;

      // Binary: skip for discovery (documents are text)
      if (isBinaryPath(normFile)) continue;

      results.push(canonicalFile);
    }
  }

  return results;
}

/**
 * Discover context documents matching configured patterns.
 */
export async function discoverContextDocuments(
  project: ResolvedProject,
  policy: SecurityPolicy | null,
  opts?: { maxDocs?: number }
): Promise<ContextDocSummary[]> {
  const maxDocs = opts?.maxDocs ?? DEFAULT_LIMITS.maxContextDocsPerProject;

  if (!project.contextPatterns || project.contextPatterns.length === 0) {
    return [];
  }

  // Walk entire project tree (bounded) and filter by patterns
  const visited = new Set<string>();
  const allFiles = await walk(project.canonicalPath, project.canonicalPath, policy, visited);

  const summaries: ContextDocSummary[] = [];
  const projectPosix = project.canonicalPath.split(path.sep).join(path.posix.sep);

  for (const absPath of allFiles) {
    // Compute relative posix path
    const rel = path.relative(project.canonicalPath, absPath);
    const relPosix = rel.split(path.sep).join(path.posix.sep);

    // Check pattern match: patterns are relative globs like "TODO.md", "docs/**/*.md"
    let matched: string | null = null;
    for (const pat of project.contextPatterns) {
      const patPosix = pat.split(path.sep).join(path.posix.sep);
      // Match relative path OR basename for simple patterns
      if (minimatch(relPosix, patPosix, { dot: true }) || minimatch(path.posix.basename(relPosix), patPosix, { dot: true })) {
        matched = pat;
        break;
      }
    }
    if (!matched) continue;

    // Stat
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    summaries.push({
      path: relPosix,
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
