/**
 * Security / path policy: allowlisting, traversal prevention, symlink escapes,
 * secret exclusions, binary handling, size limits.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";

// ---------------------------------------------------------------------------
// Secret / sensitive patterns — denied by default
// ---------------------------------------------------------------------------

/**
 * Basename patterns and path-segment patterns that are always denied,
 * even if they match a context-document allowlist.
 *
 * This list is intentionally conservative. Users cannot allowlist these via
 * normal context patterns; they would need to explicitly edit policy (not MVP).
 */
export const DENIED_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
]);

export const DENIED_BASENAME_GLOBS = [
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  "*.kdbx",
];

export const DENIED_PATH_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".gnupg2",
  ".docker",
  ".kube",
]);

export const DENIED_PATH_GLOBS = [
  "**/.git/**", // we inspect git via git commands, not raw .git file reads
  "**/node_modules/**",
];

export const DENIED_FILE_GLOBS_EXACT: string[] = [
  "**/.netrc",
  "**/.npmrc",
  "**/.pypirc",
  "**/credentials",
  "**/credentials.json",
  "**/*secret*",
  "**/*token*",
  "**/*credential*",
];

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".a", ".o",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".bin", ".dat", ".sqlite", ".db",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isBinaryPath(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function containsDeniedSegment(canonicalPath: string, projectRoot: string): boolean {
  // Walk path segments relative to project root, and also check absolute segments
  // For absolute path outside project: check all segments.
  const segs = canonicalPath.split(path.sep).filter(Boolean);
  for (const seg of segs) {
    if (DENIED_PATH_SEGMENTS.has(seg) || DENIED_PATH_SEGMENTS.has(seg.toLowerCase())) return true;
  }
  // Also check relative to project root segments
  try {
    const rel = path.relative(projectRoot, canonicalPath);
    if (rel.startsWith("..")) return false; // outside root — already denied elsewhere
    const relSegs = rel.split(path.sep).filter(Boolean);
    for (const seg of relSegs) {
      if (DENIED_PATH_SEGMENTS.has(seg)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  // Use minimatch with dot:true and matchBase false — paths are posix-ish.
  // Normalize to posix for glob matching.
  const posix = filePath.split(path.sep).join(path.posix.sep);
  for (const g of globs) {
    if (minimatch(posix, g, { dot: true, nocase: false })) return true;
    // Also try basename match for simple globs
    const base = path.posix.basename(posix);
    if (minimatch(base, g, { dot: true })) return true;
  }
  return false;
}

export function isDeniedByPolicy(
  canonicalPath: string,
  projectRoot: string,
  opts?: { allowBinary?: boolean }
): { denied: boolean; reason?: string } {
  const base = path.basename(canonicalPath);
  const baseLower = base.toLowerCase();
  const segs = canonicalPath.split(path.sep).filter(Boolean);

  // `**/.git/**` does not match the exact `.git` directory itself.
  if (baseLower === ".git" || segs.some((seg) => seg.toLowerCase() === ".git")) {
    return { denied: true, reason: "denied .git path" };
  }

  // 1. Exact denied basenames (case-insensitive: macOS default is case-preserving)
  if (DENIED_BASENAMES.has(base) || DENIED_BASENAMES.has(baseLower)) {
    return { denied: true, reason: `denied basename: ${base}` };
  }

  // 2. Basename globs
  for (const g of DENIED_BASENAME_GLOBS) {
    if (minimatch(base, g, { dot: true, nocase: true })) {
      return { denied: true, reason: `denied basename glob ${g}: ${base}` };
    }
  }

  // 3. Denied path segments
  if (containsDeniedSegment(canonicalPath, projectRoot)) {
    return { denied: true, reason: `denied path segment in ${canonicalPath}` };
  }

  // 4. Path globs (including .git, node_modules, secret/token names)
  const allDeniedGlobs = [...DENIED_PATH_GLOBS, ...DENIED_FILE_GLOBS_EXACT];
  if (matchesAnyGlob(canonicalPath, allDeniedGlobs)) {
    return { denied: true, reason: `denied path glob in ${canonicalPath}` };
  }
  // Also check relative path globs
  try {
    const rel = path.relative(projectRoot, canonicalPath);
    if (!rel.startsWith("..") && rel !== "") {
      const relPosix = rel.split(path.sep).join(path.posix.sep);
      if (matchesAnyGlob(relPosix, allDeniedGlobs) || matchesAnyGlob(canonicalPath, allDeniedGlobs)) {
        return { denied: true, reason: `denied relative glob: ${rel}` };
      }
    }
  } catch { /* ignore */ }

  // 5. Binary check
  if (!opts?.allowBinary && isBinaryPath(canonicalPath)) {
    return { denied: true, reason: `binary file denied: ${base}` };
  }

  return { denied: false };
}

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

export class SecurityPolicy {
  private allowedRoots: string[]; // canonical realpaths, normalized, no trailing slash

  constructor(allowedRoots: string[]) {
    // Normalize: realpath if exists (handles /var -> /private/var on macOS), ensure no trailing sep
    this.allowedRoots = allowedRoots.map((r) => {
      let canon: string;
      try {
        canon = fs.realpathSync(r);
      } catch {
        canon = path.normalize(r);
      }
      return canon.replace(/\/+$/, "") || "/";
    });
  }

  get roots(): string[] {
    return [...this.allowedRoots];
  }

  /**
   * Whether `requestedPath` is within any allowed root, after realpath canonicalization.
   * Prevents `..` traversal and symlink escapes.
   *
   * Strategy:
   *  - Resolve requestedPath to absolute.
   *  - Try to realpath it (if file exists). If it does not exist, realpath the longest existing ancestor
   *    and then append the non-existing tail, resolving `..` and `.` lexically.
   *  - Check that the resulting canonical path is equal to or inside an allowed root.
   *
   * Returns canonical path on success, throws on violation.
   */
  async canonicalizeAndCheck(requestedPath: string): Promise<string> {
    const absolute = path.isAbsolute(requestedPath)
      ? path.normalize(requestedPath)
      : path.resolve(requestedPath);

    const canonical = await this.realpathWithMissingTail(absolute);

    if (!this.isInsideAllowedRoot(canonical)) {
      throw new PolicyError(
        `Path escapes allowed roots: ${requestedPath} -> ${canonical}`,
        "PATH_ESCAPE"
      );
    }
    return canonical;
  }

  /**
   * Synchronous variant for hot paths where async is undesirable.
   * Best-effort: uses realpathSync where possible.
   */
  canonicalizeAndCheckSync(requestedPath: string): string {
    const absolute = path.isAbsolute(requestedPath)
      ? path.normalize(requestedPath)
      : path.resolve(requestedPath);
    const canonical = this.realpathWithMissingTailSync(absolute);
    if (!this.isInsideAllowedRoot(canonical)) {
      throw new PolicyError(
        `Path escapes allowed roots: ${requestedPath} -> ${canonical}`,
        "PATH_ESCAPE"
      );
    }
    return canonical;
  }

  /**
   * Check whether a canonical path is inside any allowed root.
   * Both canonical and roots should be normalized and realpath'd.
   */
  isInsideAllowedRoot(canonicalPath: string): boolean {
    const norm = path.normalize(canonicalPath).replace(/\/+$/, "") || "/";
    for (const root of this.allowedRoots) {
      if (norm === root) return true;
      // Ensure separator boundary: /a/b is inside /a, but /a-b is not
      if (norm.startsWith(root + path.sep)) return true;
    }
    return false;
  }

  /**
   * Ensure `candidate` is inside `baseDir` (canonical). Throws if not.
   */
  assertInside(candidateCanonical: string, baseCanonical: string, label = "path"): void {
    const cand = path.normalize(candidateCanonical).replace(/\/+$/, "") || "/";
    const base = path.normalize(baseCanonical).replace(/\/+$/, "") || "/";
    if (cand !== base && !cand.startsWith(base + path.sep)) {
      throw new PolicyError(`${label} escapes base: ${candidateCanonical} not inside ${baseCanonical}`, "PATH_ESCAPE");
    }
  }

  private async realpathWithMissingTail(target: string): Promise<string> {
    // Walk up until we find an existing ancestor to realpath, then re-append tail.
    let cur = target;
    const missing: string[] = [];
    while (true) {
      try {
        // lstat to see if exists without following final symlink? But we want to follow.
        await fs.promises.lstat(cur);
        // Exists — realpath it
        const real = await fs.promises.realpath(cur);
        // Re-append missing tail, normalizing
        if (missing.length === 0) return path.normalize(real);
        // missing was collected from leaf up, so reverse
        missing.reverse();
        return path.normalize(path.join(real, ...missing));
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          const parent = path.dirname(cur);
          if (parent === cur) {
            // Reached root and still missing — return normalized target
            missing.reverse();
            // Use lexical normalization only
            return path.normalize(target);
          }
          missing.push(path.basename(cur));
          cur = parent;
          continue;
        }
        throw e;
      }
    }
  }

  private realpathWithMissingTailSync(target: string): string {
    let cur = target;
    const missing: string[] = [];
    while (true) {
      try {
        fs.lstatSync(cur);
        const real = fs.realpathSync(cur);
        if (missing.length === 0) return path.normalize(real);
        missing.reverse();
        return path.normalize(path.join(real, ...missing));
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          const parent = path.dirname(cur);
          if (parent === cur) {
            missing.reverse();
            return path.normalize(target);
          }
          missing.push(path.basename(cur));
          cur = parent;
          continue;
        }
        throw e;
      }
    }
  }
}

export class PolicyError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}
