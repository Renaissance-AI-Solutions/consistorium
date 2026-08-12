/**
 * MCP tool definitions for Context Bridge.
 * Each tool has a name, description, inputSchema (JSON Schema), and handler.
 */
import { z } from "zod";
import { zodToJsonSchema } from "./zodToJson.js";

// We avoid depending on zod-to-json-schema lib to keep deps minimal; we inline a tiny converter below.
// Actually we generate JSON Schema manually for control.

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// We produce draft 2020-12-ish schemas. MCP SDK expects JSON Schema object.

function mkSchema(shape: Record<string, { type: string; description?: string; required?: boolean; enum?: string[]; default?: unknown }>, required: string[] = []): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) {
    const prop: Record<string, unknown> = { type: v.type };
    if (v.description) prop.description = v.description;
    if (v.enum) prop.enum = v.enum;
    if (v.default !== undefined) prop.default = v.default;
    properties[k] = prop;
  }
  return {
    type: "object",
    properties,
    required: required.length ? required : undefined,
    additionalProperties: false,
  };
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "context.list_projects",
    description: "List all explicitly configured projects with their canonical path and git status. No arguments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "context.project_snapshot",
    description:
      "Hero tool: return a structured snapshot of a project's live state — git branch/HEAD/dirty, worktrees with changes, recent commits, context documents, and agent sessions. Prefer this before strategic advice. Bounded output.",
    inputSchema: mkSchema(
      {
        project: { type: "string", description: "Project name as configured (e.g., 'my-project')" },
        recentLimit: { type: "number", description: "Number of recent commits to include (1-50, default 10)" },
        includeSessions: { type: "boolean", description: "Include agent sessions (default true)" },
      },
      ["project"]
    ),
  },
  {
    name: "context.list_worktrees",
    description: "List all git worktrees for a project, with branch, HEAD, dirty state, staged/unstaged changes, untracked preview, and ahead/behind.",
    inputSchema: mkSchema(
      {
        project: { type: "string", description: "Project name" },
      },
      ["project"]
    ),
  },
  {
    name: "context.worktree_snapshot",
    description: "Detailed snapshot of a single worktree by path. Reports branch, HEAD, dirty state, and file changes.",
    inputSchema: mkSchema(
      {
        project: { type: "string", description: "Project name" },
        path: { type: "string", description: "Worktree filesystem path (must be inside allowed project)" },
      },
      ["project", "path"]
    ),
  },
  {
    name: "context.recent_changes",
    description: "Recent commits, changed-file stats, and diff stat for a project or specific worktree. Bounded.",
    inputSchema: mkSchema(
      {
        project: { type: "string", description: "Project name" },
        limit: { type: "number", description: "Commits to return (1-100, default 20)" },
        worktreePath: { type: "string", description: "Optional worktree path to inspect instead of main project root" },
        includeDiffStat: { type: "boolean", description: "Include diff stat (default true)" },
      },
      ["project"]
    ),
  },
  {
    name: "context.compare",
    description:
      "Compare two local refs/branches/commits within a project (e.g., main vs feature). Returns merge-base, ahead/behind, commits, diff stat, and optionally bounded textual diff.",
    inputSchema: mkSchema(
      {
        project: { type: "string", description: "Project name" },
        base: { type: "string", description: "Base ref (e.g., 'main', 'HEAD~5', sha)" },
        target: { type: "string", description: "Target ref to compare against base" },
        includeDiff: { type: "boolean", description: "Include bounded textual diff (default false)" },
        maxDiffBytes: { type: "number", description: "Max diff bytes when includeDiff is true (default 128k, max 500k)" },
        worktreePath: { type: "string", description: "Optional worktree path context" },
      },
      ["project", "base", "target"]
    ),
  },
  {
    name: "context.search",
    description:
      "Bounded text/code search within allowed project roots. Respects secret/binary exclusions. Returns file/line/preview (not blobs).",
    inputSchema: mkSchema(
      {
        project: { type: "string", description: "Project name to search within" },
        query: { type: "string", description: "Search string (plain text, 1-500 chars)" },
        maxResults: { type: "number", description: "Max results (1-100, default 50)" },
        caseSensitive: { type: "boolean", description: "Case-sensitive search (default false)" },
      },
      ["project", "query"]
    ),
  },
  {
    name: "context.list_context_documents",
    description:
      "List discovered context documents (TODO.md, ROADMAP.md, docs/**/*.md etc.) as configured per project. Only allowlisted patterns are surfaced.",
    inputSchema: mkSchema(
      {
        project: { type: "string", description: "Project name" },
      },
      ["project"]
    ),
  },
  {
    name: "context.read_context_document",
    description:
      "Read a specific context document by relative path (must match project's allowlisted patterns and pass security policy). Bounded output.",
    inputSchema: mkSchema(
      {
        project: { type: "string", description: "Project name" },
        path: { type: "string", description: "Relative path of document (e.g., 'TODO.md' or 'docs/architecture.md')" },
        maxBytes: { type: "number", description: "Max bytes to read (default 256k, max 1M)" },
      },
      ["project", "path"]
    ),
  },
  {
    name: "context.list_agent_sessions",
    description:
      "List discovered agent/session artifacts via configured session adapter (generic file-glob adapter by default). Normalized to harness/model/state/title/timestamps.",
    inputSchema: mkSchema({
      project: { type: "string", description: "Optional project name to filter sessions" },
    }),
  },
  {
    name: "context.session_snapshot",
    description: "Detailed snapshot of a single agent session by id, including bounded redacted preview of source artifact.",
    inputSchema: mkSchema(
      {
        id: { type: "string", description: "Session id as returned by list_agent_sessions" },
      },
      ["id"]
    ),
  },
];
