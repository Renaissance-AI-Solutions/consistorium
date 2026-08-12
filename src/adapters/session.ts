/**
 * Generic session-artifact adapter interface and generic implementation.
 *
 * Architecture supports multiple adapters; v0.1 ships:
 * - GenericSessionAdapter: inspects explicitly configured artifact globs.
 * - NoopAdapter: when no patterns configured.
 *
 * Future adapters (Codex, Claude Code, etc.) implement the same interface.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";
import type { SessionSummary, SessionSnapshot, ResolvedConfig, ResolvedProject } from "../core/types.js";
import { DEFAULT_LIMITS } from "../core/types.js";
import { isDeniedByPolicy, isBinaryPath, type SecurityPolicy } from "../core/security.js";

export interface SessionAdapter {
  name: string;
  listSessions(config: ResolvedConfig, policy: SecurityPolicy): Promise<SessionSummary[]>;
  getSessionSnapshot(
    config: ResolvedConfig,
    policy: SecurityPolicy,
    id: string
  ): Promise<SessionSnapshot | null>;
}

interface ParsedSessionMeta {
  harness?: string;
  model?: string;
  state?: string;
  title?: string;
  startedAt?: string;
  updatedAt?: string;
  project?: string;
  worktreePath?: string;
  relatedFiles?: string[];
  summary?: string;
}

// ---------------------------------------------------------------------------
// Helpers: collect files matching patterns (glob relative to each project root,
// or absolute paths that must still be inside allowed roots)
// ---------------------------------------------------------------------------

async function collectArtifactFiles(
  config: ResolvedConfig,
  policy: SecurityPolicy
): Promise<{ project: ResolvedProject; absolutePath: string; canonicalPath: string }[]> {
  const patterns = config.sessionArtifacts.patterns;
  if (!patterns || patterns.length === 0) return [];

  const results: { project: ResolvedProject; absolutePath: string; canonicalPath: string }[] = [];

  for (const project of config.projects) {
    // For each project, walk and match patterns
    const visited = new Set<string>();
    const files = await walkProject(project.canonicalPath, policy, visited);

    for (const abs of files) {
      const relPosix = path.relative(project.canonicalPath, abs).split(path.sep).join(path.posix.sep);
      const basePosix = path.posix.basename(relPosix);

      for (const pat of patterns) {
        // Pattern may be absolute or relative
        if (path.isAbsolute(pat)) {
          // Absolute pattern: match canonical path
          const patPosix = pat.split(path.sep).join(path.posix.sep);
          if (minimatch(abs.split(path.sep).join(path.posix.sep), patPosix, { dot: true })) {
            // Containment still required
            if (!policy.isInsideAllowedRoot(abs)) continue;
            const denied = isDeniedByPolicy(abs, project.canonicalPath);
            if (denied.denied) continue;
            results.push({ project, absolutePath: abs, canonicalPath: abs });
            break;
          }
        } else {
          const patPosix = pat.split(path.sep).join(path.posix.sep);
          if (
            minimatch(relPosix, patPosix, { dot: true }) ||
            minimatch(basePosix, patPosix, { dot: true }) ||
            minimatch(abs.split(path.sep).join(path.posix.sep), patPosix, { dot: true })
          ) {
            const denied = isDeniedByPolicy(abs, project.canonicalPath);
            if (denied.denied) continue;
            if (isBinaryPath(abs)) continue;
            if (!policy.isInsideAllowedRoot(abs)) continue;
            results.push({ project, absolutePath: abs, canonicalPath: abs });
            break;
          }
        }
      }
    }

    // Also handle absolute patterns that may point outside project tree but still inside allowed roots
    for (const pat of patterns) {
      if (!path.isAbsolute(pat)) continue;
      // Try glob expansion for absolute patterns that didn't match walked files
      // For simplicity, if pattern contains *, we already handled via walk within project.
      // For exact absolute file, check existence directly.
      if (!pat.includes("*") && !pat.includes("?") && !pat.includes("[")) {
        try {
          const real = await fs.promises.realpath(pat);
          const norm = path.normalize(real).replace(/\/+$/, "") || "/";
          if (!policy.isInsideAllowedRoot(norm)) continue;
          const denied = isDeniedByPolicy(norm, project.canonicalPath);
          if (denied.denied) continue;
          if (isBinaryPath(norm)) continue;
          // Avoid duplicates
          if (results.some((r) => r.canonicalPath === norm)) continue;
          const st = await fs.promises.stat(norm).catch(() => null);
          if (st?.isFile()) {
            results.push({ project, absolutePath: pat, canonicalPath: norm });
          }
        } catch {
          // ignore
        }
      }
    }
  }

  return results;
}

async function walkProject(
  dir: string,
  policy: SecurityPolicy,
  visited: Set<string>
): Promise<string[]> {
  const results: string[] = [];
  let canonicalDir: string;
  try {
    canonicalDir = await fs.promises.realpath(dir);
  } catch {
    return results;
  }
  if (visited.has(canonicalDir)) return results;
  visited.add(canonicalDir);

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    // Skip well-known heavy dirs
    if (ent.isDirectory()) {
      if (ent.name === ".git" || ent.name === "node_modules" || ent.name === "dist" || ent.name === "build") continue;
      if (ent.name === ".ssh" || ent.name === ".aws" || ent.name === ".gnupg") continue;
      const sub = await walkProject(full, policy, visited);
      results.push(...sub);
    } else if (ent.isSymbolicLink()) {
      try {
        const real = await fs.promises.realpath(full);
        const st = await fs.promises.stat(real);
        if (st.isDirectory()) {
          // Check symlink escape
          const normReal = path.normalize(real).replace(/\/+$/, "") || "/";
          if (!policy.isInsideAllowedRoot(normReal)) continue;
          const sub = await walkProject(real, policy, visited);
          results.push(...sub);
        } else if (st.isFile()) {
          const normReal = path.normalize(real).replace(/\/+$/, "") || "/";
          if (!policy.isInsideAllowedRoot(normReal)) continue;
          results.push(normReal);
        }
      } catch {
        continue;
      }
    } else if (ent.isFile()) {
      try {
        const real = await fs.promises.realpath(full);
        const normReal = path.normalize(real).replace(/\/+$/, "") || "/";
        if (!policy.isInsideAllowedRoot(normReal)) continue;
        results.push(normReal);
      } catch {
        continue;
      }
    }
  }
  return results;
}

function parseSessionMeta(content: string, filePath: string): ParsedSessionMeta {
  // Try JSON first
  try {
    const j = JSON.parse(content);
    if (j && typeof j === "object") {
      return {
        harness: typeof j.harness === "string" ? j.harness : typeof j.agent === "string" ? j.agent : undefined,
        model: typeof j.model === "string" ? j.model : undefined,
        state: typeof j.state === "string" ? j.state : typeof j.status === "string" ? j.status : undefined,
        title: typeof j.title === "string" ? j.title : typeof j.task === "string" ? j.task : undefined,
        startedAt: typeof j.startedAt === "string" ? j.startedAt : typeof j.started_at === "string" ? j.started_at : undefined,
        updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : typeof j.updated_at === "string" ? j.updated_at : undefined,
        project: typeof j.project === "string" ? j.project : undefined,
        worktreePath: typeof j.worktreePath === "string" ? j.worktreePath : typeof j.worktree === "string" ? j.worktree : undefined,
        relatedFiles: Array.isArray(j.relatedFiles) ? j.relatedFiles.filter((x: unknown) => typeof x === "string") : undefined,
        summary: typeof j.summary === "string" ? j.summary : typeof j.preview === "string" ? j.preview : undefined,
      };
    }
  } catch {
    // not json
  }

  // Fallback: treat first line as title, look for harness markers
  const lines = content.split("\n");
  const firstNonEmpty = lines.find((l) => l.trim().length > 0)?.trim();
  let harness: string | undefined;
  const lower = content.toLowerCase();
  if (lower.includes("codex")) harness = "codex";
  else if (lower.includes("claude")) harness = "claude-code";
  else if (lower.includes("hermes")) harness = "hermes";
  else if (lower.includes("cline")) harness = "cline";

  return {
    harness,
    title: firstNonEmpty?.slice(0, 200),
    summary: content.slice(0, 2000),
  };
}

function redactSecrets(text: string): string {
  // Very conservative redaction: replace obvious secret patterns with [REDACTED]
  // This is not a guarantee, but a best-effort for session previews.
  return text
    .replace(/(sk-[a-zA-Z0-9]{20,})/g, "[REDACTED]")
    .replace(/(ghp_[a-zA-Z0-9]{20,})/g, "[REDACTED]")
    .replace(/(AKIA[0-9A-Z]{16})/g, "[REDACTED]")
    .replace(/(-----BEGIN (?:RSA )?PRIVATE KEY-----)/g, "[REDACTED PRIVATE KEY]")
    .replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, (m) => {
      // Keep local part length hint but redact domain? Simpler: keep as is for now, emails are often not secret.
      return m;
    });
}

// ---------------------------------------------------------------------------
// GenericSessionAdapter
// ---------------------------------------------------------------------------

export class GenericSessionAdapter implements SessionAdapter {
  name = "generic";

  async listSessions(config: ResolvedConfig, policy: SecurityPolicy): Promise<SessionSummary[]> {
    const files = await collectArtifactFiles(config, policy);
    const summaries: SessionSummary[] = [];

    for (const { project, canonicalPath } of files) {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(canonicalPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > DEFAULT_LIMITS.maxFileSizeBytes) {
        // Still list, but mark truncated and don't read full content
      }

      let content = "";
      try {
        const maxRead = Math.min(stat.size, 16 * 1024);
        const fd = await fs.promises.open(canonicalPath, "r");
        try {
          const buf = Buffer.alloc(maxRead);
          const { bytesRead } = await fd.read(buf, 0, maxRead, 0);
          content = buf.subarray(0, bytesRead).toString("utf-8");
        } finally {
          await fd.close();
        }
      } catch {
        content = "";
      }

      const meta = parseSessionMeta(content, canonicalPath);
      const id = `${project.name}:${path.relative(project.canonicalPath, canonicalPath).split(path.sep).join(path.posix.sep)}`;

      // Derive timestamps from file mtime if not in meta
      const mtimeIso = stat.mtime.toISOString();
      const startedAt = meta.startedAt ?? null;
      const updatedAt = meta.updatedAt ?? mtimeIso;

      let summaryPreview: string | null = null;
      if (meta.summary) {
        const redacted = redactSecrets(meta.summary.slice(0, 2000));
        summaryPreview = redacted.length > 500 ? redacted.slice(0, 500) + " …[truncated]" : redacted;
      } else if (content) {
        const redacted = redactSecrets(content.slice(0, 2000));
        summaryPreview = redacted.length > 500 ? redacted.slice(0, 500) + " …[truncated]" : redacted;
      }

      summaries.push({
        id,
        harness: meta.harness ?? "generic",
        model: meta.model ?? null,
        project: meta.project ?? project.name,
        worktreePath: meta.worktreePath ?? null,
        state: meta.state ?? null,
        title: meta.title ?? path.basename(canonicalPath),
        startedAt,
        updatedAt,
        relatedFiles: meta.relatedFiles ?? [],
        summaryPreview,
        sourcePath: canonicalPath,
        provenance: {
          observedAt: new Date().toISOString(),
          projectName: project.name,
          projectPath: project.canonicalPath,
        },
      });
    }

    // Sort by updatedAt desc
    summaries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return summaries;
  }

  async getSessionSnapshot(
    config: ResolvedConfig,
    policy: SecurityPolicy,
    id: string
  ): Promise<SessionSnapshot | null> {
    const all = await this.listSessions(config, policy);
    const found = all.find((s) => s.id === id);
    if (!found) return null;

    // Read bounded raw preview of the source file
    let rawPreview: string | null = null;
    let truncated = false;
    try {
      const stat = await fs.promises.stat(found.sourcePath);
      const maxBytes = DEFAULT_LIMITS.maxFileSizeBytes;
      if (stat.size > maxBytes) truncated = true;
      const toRead = Math.min(stat.size, maxBytes);
      const fd = await fs.promises.open(found.sourcePath, "r");
      try {
        const buf = Buffer.alloc(toRead);
        const { bytesRead } = await fd.read(buf, 0, toRead, 0);
        rawPreview = redactSecrets(buf.subarray(0, bytesRead).toString("utf-8"));
        if (truncated) rawPreview += "\n... [truncated]";
      } finally {
        await fd.close();
      }
    } catch {
      rawPreview = null;
    }

    return {
      ...found,
      rawPreview,
      truncated,
    };
  }
}

export class NoopSessionAdapter implements SessionAdapter {
  name = "noop";
  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }
  async getSessionSnapshot(): Promise<SessionSnapshot | null> {
    return null;
  }
}
