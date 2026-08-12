/**
 * Bounded text/code search within allowed roots.
 * Respects exclusions, binary skip, size limits.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";
import type { SearchResult, SearchResponse } from "../core/types.js";
import { DEFAULT_LIMITS } from "../core/types.js";
import { isDeniedByPolicy, isBinaryPath, type SecurityPolicy } from "../core/security.js";
import type { ResolvedProject } from "../core/types.js";

export interface SearchOptions {
  query: string;
  project: ResolvedProject;
  policy: SecurityPolicy | null;
  maxResults?: number;
  maxFileSizeBytes?: number;
  includeGlobs?: string[]; // optional filter on relative paths
  excludeGlobs?: string[]; // additional excludes
  caseSensitive?: boolean;
}

const DEFAULT_EXCLUDES = [
  ".git/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  ".next/**",
  "coverage/**",
  "*.min.js",
  "*.bundle.js",
];

async function* walkFiles(
  dir: string,
  projectRoot: string,
  policy: SecurityPolicy | null,
  visited: Set<string>,
  maxFileSizeBytes: number
): AsyncGenerator<string> {
  let canonicalDir: string;
  try {
    canonicalDir = await fs.promises.realpath(dir);
  } catch {
    return;
  }
  if (visited.has(canonicalDir)) return;
  visited.add(canonicalDir);

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const ent of entries) {
    const full = path.join(dir, ent.name);

    // Quick skip for well-known dirs before stat
    if (ent.isDirectory() || ent.isSymbolicLink()) {
      const base = ent.name;
      if (base === ".git" || base === "node_modules" || base === ".ssh" || base === ".aws" || base === ".gnupg") {
        continue;
      }
      // Check segment deny via path
      const canonProject = await fs.promises.realpath(projectRoot).catch(() => path.normalize(projectRoot));
      // We'll check inside recursion
      let subStat: fs.Stats | null = null;
      try {
        subStat = await fs.promises.lstat(full);
      } catch {
        continue;
      }

      if (ent.isDirectory() || (ent.isSymbolicLink() && subStat.isDirectory?.())) {
        // For symlink dir, containment check
        if (ent.isSymbolicLink()) {
          try {
            const real = await fs.promises.realpath(full);
            const normReal = path.normalize(real).replace(/\/+$/, "") || "/";
            const normProject = path.normalize(canonProject).replace(/\/+$/, "") || "/";
            if (normReal !== normProject && !normReal.startsWith(normProject + path.sep)) continue;
            const denied = isDeniedByPolicy(normReal, canonProject);
            if (denied.denied) continue;
          } catch {
            continue;
          }
        }
        // Recurse
        yield* walkFiles(full, projectRoot, policy, visited, maxFileSizeBytes);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        // File at this level handled below
        // But Dirent was isDirectory, so skip
        continue;
      }
    } else if (ent.isFile() || ent.isSymbolicLink()) {
      let canonicalFile: string;
      try {
        canonicalFile = await fs.promises.realpath(full);
      } catch {
        continue;
      }
      const canonProject = await fs.promises.realpath(projectRoot).catch(() => path.normalize(projectRoot));
      const normFile = path.normalize(canonicalFile).replace(/\/+$/, "") || "/";
      const normProject = path.normalize(canonProject).replace(/\/+$/, "") || "/";
      if (normFile !== normProject && !normFile.startsWith(normProject + path.sep)) continue;
      if (policy && !policy.isInsideAllowedRoot(normFile)) continue;
      const denied = isDeniedByPolicy(normFile, canonProject);
      if (denied.denied) continue;
      if (isBinaryPath(normFile)) continue;

      // Size check
      try {
        const st = await fs.promises.stat(canonicalFile);
        if (!st.isFile()) continue;
        if (st.size > maxFileSizeBytes) continue;
        // Exclude globs checked outside
      } catch {
        continue;
      }

      yield canonicalFile;
    }
  }
}

export async function searchInProject(opts: SearchOptions): Promise<SearchResponse> {
  const query = opts.query;
  if (!query || query.length === 0) {
    throw Object.assign(new Error("Search query must be non-empty"), { code: "INVALID_QUERY" });
  }
  if (query.length > 500) {
    throw Object.assign(new Error("Search query too long (max 500 chars)"), { code: "INVALID_QUERY" });
  }

  const maxResults = Math.min(opts.maxResults ?? DEFAULT_LIMITS.maxSearchResults, 500);
  const maxFileSizeBytes = opts.maxFileSizeBytes ?? DEFAULT_LIMITS.maxSearchFileSizeBytes;
  const caseSensitive = opts.caseSensitive ?? false;
  const needle = caseSensitive ? query : query.toLowerCase();

  const visited = new Set<string>();
  const results: SearchResult[] = [];
  let searchedFiles = 0;
  let totalMatches = 0;
  let truncated = false;

  // Prepare include/exclude filters (relative posix globs)
  const excludes = [...DEFAULT_EXCLUDES, ...(opts.excludeGlobs ?? [])];

  for await (const absPath of walkFiles(
    opts.project.canonicalPath,
    opts.project.canonicalPath,
    opts.policy,
    visited,
    maxFileSizeBytes
  )) {
    if (results.length >= maxResults) {
      truncated = true;
      break;
    }

    const rel = path.relative(opts.project.canonicalPath, absPath);
    const relPosix = rel.split(path.sep).join(path.posix.sep);

    // Include filter
    if (opts.includeGlobs && opts.includeGlobs.length > 0) {
      let inc = false;
      for (const g of opts.includeGlobs) {
        const pat = g.split(path.sep).join(path.posix.sep);
        if (minimatch(relPosix, pat, { dot: true }) || minimatch(path.posix.basename(relPosix), pat, { dot: true })) {
          inc = true;
          break;
        }
      }
      if (!inc) continue;
    }
    // Exclude filter
    let excluded = false;
    for (const g of excludes) {
      const pat = g.split(path.sep).join(path.posix.sep);
      if (minimatch(relPosix, pat, { dot: true })) {
        excluded = true;
        break;
      }
    }
    if (excluded) continue;

    // Read file and search line by line
    let content: string;
    try {
      content = await fs.promises.readFile(absPath, "utf-8");
    } catch {
      continue;
    }
    searchedFiles++;

    // Quick check if file contains query at all
    const hay = caseSensitive ? content : content.toLowerCase();
    if (!hay.includes(needle)) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineHay = caseSensitive ? line : line.toLowerCase();
      const idx = lineHay.indexOf(needle);
      if (idx !== -1) {
        totalMatches++;
        if (results.length < maxResults) {
          // Preview: trim and limit to 300 chars
          let preview = line.trim();
          if (preview.length > 300) {
            // Center around match if long
            const start = Math.max(0, idx - 80);
            preview = (start > 0 ? "… " : "") + line.slice(start, start + 300).trim() + (line.length > start + 300 ? " …" : "");
          }
          results.push({
            path: relPosix,
            canonicalPath: absPath,
            line: i + 1,
            column: idx + 1,
            preview,
            matchedText: line.slice(idx, idx + query.length),
          });
        } else {
          truncated = true;
        }
        // One result per line; if many matches on same line, we count only one.
        // To be more precise, we could count all occurrences per line, but single is simpler and bounded.
      }
      if (results.length >= maxResults && totalMatches > maxResults) {
        truncated = true;
        break;
      }
    }
  }

  return {
    query,
    results,
    truncated,
    totalMatches,
    searchedFiles,
    provenance: {
      observedAt: new Date().toISOString(),
      projectName: opts.project.name,
      projectPath: opts.project.canonicalPath,
    },
  };
}
