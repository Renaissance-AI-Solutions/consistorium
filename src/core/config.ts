/**
 * Configuration loading, validation, and resolution.
 * Supports YAML and JSON configs.
 *
 * Search order for config file (when no explicit path):
 * 1. $CONTEXT_BRIDGE_CONFIG env var
 * 2. $PLUGIN_DATA/config.yaml  (when PLUGIN_DATA is set)
 * 3. $XDG_CONFIG_HOME/context-bridge/config.yaml  or ~/.config/context-bridge/config.yaml
 * 4. ./.context-bridge.yaml in cwd
 * 5. ./context-bridge.yaml in cwd
 *
 * For MCP stdio, the host may pass config via env/context.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as yaml from "yaml";
import { z } from "zod";
import type { ResolvedConfig, ResolvedProject, RawConfig } from "./types.js";
import { DEFAULT_LIMITS, SAFE_ID_MESSAGE, SAFE_ID_REGEX } from "./types.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ProjectSchema = z.object({
  name: z.string().min(1).max(128).regex(SAFE_ID_REGEX, SAFE_ID_MESSAGE),
  path: z.string().min(1),
  context: z.array(z.string().min(1)).optional().default([]),
});

const ConfigSchema = z.object({
  version: z.number().optional().default(1),
  projects: z.array(ProjectSchema).min(1, "at least one project required"),
  sessionArtifacts: z
    .object({
      patterns: z.array(z.string().min(1)).optional().default([]),
    })
    .optional()
    .default({ patterns: [] }),
  search: z
    .object({
      maxResults: z.number().int().min(1).max(500).optional(),
      maxFileSizeBytes: z.number().int().min(1024).max(10 * 1024 * 1024).optional(),
    })
    .optional(),
  limits: z
    .object({
      maxFileSizeBytes: z.number().int().min(1024).max(10 * 1024 * 1024).optional(),
      maxDiffBytes: z.number().int().min(1024).max(5 * 1024 * 1024).optional(),
      maxSearchResults: z.number().int().min(1).max(500).optional(),
      maxWorktrees: z.number().int().min(1).max(DEFAULT_LIMITS.maxWorktrees).optional(),
    })
    .optional(),
});

function assertProjectName(name: string): void {
  if (!SAFE_ID_REGEX.test(name)) {
    throw new Error(`Invalid project name "${name}": ${SAFE_ID_MESSAGE}`);
  }
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

export function getDefaultConfigPaths(): string[] {
  const candidates: string[] = [];

  if (process.env.CONTEXT_BRIDGE_CONFIG) {
    candidates.push(process.env.CONTEXT_BRIDGE_CONFIG);
  }

  const pluginData = process.env.PLUGIN_DATA;
  if (pluginData) {
    candidates.push(path.join(pluginData, "config.yaml"));
    candidates.push(path.join(pluginData, "config.json"));
  }

  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  candidates.push(path.join(xdg, "context-bridge", "config.yaml"));
  candidates.push(path.join(xdg, "context-bridge", "config.json"));
  candidates.push(path.join(xdg, "context-bridge", "config.yml"));

  candidates.push(path.join(process.cwd(), ".context-bridge.yaml"));
  candidates.push(path.join(process.cwd(), ".context-bridge.yml"));
  candidates.push(path.join(process.cwd(), "context-bridge.yaml"));
  candidates.push(path.join(process.cwd(), "context-bridge.yml"));
  candidates.push(path.join(process.cwd(), ".context-bridge.json"));
  candidates.push(path.join(process.cwd(), "context-bridge.json"));

  return candidates;
}

export function findConfigFile(explicitPath?: string): string | null {
  if (explicitPath) {
    const abs = path.isAbsolute(explicitPath) ? explicitPath : path.resolve(explicitPath);
    if (fs.existsSync(abs)) return abs;
    // If explicit and missing, don't fallback — caller will error
    return null;
  }
  for (const p of getDefaultConfigPaths()) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Load & parse
// ---------------------------------------------------------------------------

export function parseConfigContent(content: string, filePath: string): RawConfig {
  const ext = path.extname(filePath).toLowerCase();
  let raw: unknown;
  if (ext === ".json") {
    raw = JSON.parse(content);
  } else {
    // yaml handles json too
    raw = yaml.parse(content);
  }
  // Validate via zod
  const parsed = ConfigSchema.parse(raw);
  return parsed as RawConfig;
}

export function loadConfigSync(explicitPath?: string): { raw: RawConfig; filePath: string } {
  const filePath = explicitPath
    ? path.isAbsolute(explicitPath) ? explicitPath : path.resolve(explicitPath)
    : findConfigFile();

  if (!filePath) {
    const msg = explicitPath
      ? `Config file not found: ${explicitPath}`
      : `No config file found. Searched: ${getDefaultConfigPaths().join(", ")}. Run 'consistorium init' to create one.`;
    throw new Error(msg);
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    throw new Error(`Failed to read config ${filePath}: ${(e as Error).message}`);
  }

  let raw: RawConfig;
  try {
    raw = parseConfigContent(content, filePath);
  } catch (e) {
    if (e instanceof z.ZodError) {
      const details = e.errors.map((er) => `${er.path.join(".")}: ${er.message}`).join("; ");
      throw new Error(`Invalid config ${filePath}: ${details}`);
    }
    throw new Error(`Failed to parse config ${filePath}: ${(e as Error).message}`);
  }

  return { raw, filePath };
}

// ---------------------------------------------------------------------------
// Resolve (canonicalize paths, apply defaults)
// ---------------------------------------------------------------------------

export async function resolveConfig(raw: RawConfig, configPath: string): Promise<ResolvedConfig> {
  const seenNames = new Set<string>();
  const resolvedProjects: ResolvedProject[] = [];

  for (const p of raw.projects) {
    assertProjectName(p.name);
    if (seenNames.has(p.name)) {
      throw new Error(`Duplicate project name: ${p.name}`);
    }
    seenNames.add(p.name);

    const originalPath = p.path;
    // Expand ~ and make absolute relative to config dir if needed
    const expanded = expandHome(originalPath);
    const abs = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(path.dirname(configPath), expanded);

    let canonicalPath: string;
    try {
      // Use realpath if exists, else normalize
      canonicalPath = await fs.promises.realpath(abs);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        // Project path does not exist yet — use normalized absolute as canonical
        // But warn: it won't be usable until it exists. We still keep it.
        canonicalPath = path.normalize(abs);
      } else {
        throw new Error(`Failed to resolve project path ${p.path}: ${(e as Error).message}`);
      }
    }
    // Remove trailing slash
    canonicalPath = canonicalPath.replace(/\/+$/, "") || "/";

    resolvedProjects.push({
      name: p.name,
      canonicalPath,
      originalPath: p.path,
      contextPatterns: p.context ?? [],
    });
  }

  // Validate session patterns don't contain absolute escapes? We'll allow absolute but security will check.
  const sessionPatterns = raw.sessionArtifacts?.patterns ?? [];

  return {
    version: raw.version ?? 1,
    projects: resolvedProjects,
    sessionArtifacts: { patterns: sessionPatterns },
    search: {
      maxResults: raw.search?.maxResults ?? DEFAULT_LIMITS.maxSearchResults,
      maxFileSizeBytes: raw.search?.maxFileSizeBytes ?? DEFAULT_LIMITS.maxSearchFileSizeBytes,
    },
    limits: {
      maxFileSizeBytes: raw.limits?.maxFileSizeBytes ?? DEFAULT_LIMITS.maxFileSizeBytes,
      maxDiffBytes: raw.limits?.maxDiffBytes ?? DEFAULT_LIMITS.maxDiffBytes,
      maxSearchResults: raw.limits?.maxSearchResults ?? DEFAULT_LIMITS.maxSearchResults,
      maxWorktrees: raw.limits?.maxWorktrees ?? DEFAULT_LIMITS.maxWorktrees,
    },
    configPath: await safeRealpath(configPath),
    observedAt: new Date().toISOString(),
  };
}

export function resolveConfigSync(raw: RawConfig, configPath: string): ResolvedConfig {
  const seenNames = new Set<string>();
  const resolvedProjects: ResolvedProject[] = [];

  for (const p of raw.projects) {
    assertProjectName(p.name);
    if (seenNames.has(p.name)) {
      throw new Error(`Duplicate project name: ${p.name}`);
    }
    seenNames.add(p.name);
    const expanded = expandHome(p.path);
    const abs = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(path.dirname(configPath), expanded);

    let canonicalPath: string;
    try {
      canonicalPath = fs.realpathSync(abs);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        canonicalPath = path.normalize(abs);
      } else {
        throw new Error(`Failed to resolve project path ${p.path}: ${(e as Error).message}`);
      }
    }
    canonicalPath = canonicalPath.replace(/\/+$/, "") || "/";
    resolvedProjects.push({
      name: p.name,
      canonicalPath,
      originalPath: p.path,
      contextPatterns: p.context ?? [],
    });
  }

  return {
    version: raw.version ?? 1,
    projects: resolvedProjects,
    sessionArtifacts: { patterns: raw.sessionArtifacts?.patterns ?? [] },
    search: {
      maxResults: raw.search?.maxResults ?? DEFAULT_LIMITS.maxSearchResults,
      maxFileSizeBytes: raw.search?.maxFileSizeBytes ?? DEFAULT_LIMITS.maxSearchFileSizeBytes,
    },
    limits: {
      maxFileSizeBytes: raw.limits?.maxFileSizeBytes ?? DEFAULT_LIMITS.maxFileSizeBytes,
      maxDiffBytes: raw.limits?.maxDiffBytes ?? DEFAULT_LIMITS.maxDiffBytes,
      maxSearchResults: raw.limits?.maxSearchResults ?? DEFAULT_LIMITS.maxSearchResults,
      maxWorktrees: raw.limits?.maxWorktrees ?? DEFAULT_LIMITS.maxWorktrees,
    },
    configPath: safeRealpathSync(configPath),
    observedAt: new Date().toISOString(),
  };
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return path.normalize(p);
  }
}

function safeRealpathSync(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.normalize(p);
  }
}

// ---------------------------------------------------------------------------
// Helpers for lookups
// ---------------------------------------------------------------------------

export function findProjectByName(config: ResolvedConfig, name: string): ResolvedProject | undefined {
  return config.projects.find((p) => p.name === name);
}

export function findProjectByPath(config: ResolvedConfig, canonicalPath: string): ResolvedProject | undefined {
  // Exact or parent check — if path is inside a project root, that project owns it
  const norm = path.normalize(canonicalPath).replace(/\/+$/, "") || "/";
  // Most specific (longest) match wins
  let best: ResolvedProject | undefined;
  let bestLen = -1;
  for (const p of config.projects) {
    if (norm === p.canonicalPath || norm.startsWith(p.canonicalPath + path.sep)) {
      if (p.canonicalPath.length > bestLen) {
        best = p;
        bestLen = p.canonicalPath.length;
      }
    }
  }
  return best;
}
