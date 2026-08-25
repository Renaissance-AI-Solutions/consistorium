/**
 * Transport-agnostic MCP application: config bootstrap, tool dispatch,
 * and Server construction. Used by stdio and Streamable HTTP.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfigSync, resolveConfigSync, findConfigFile } from "../core/config.js";
import { SecurityPolicy } from "../core/security.js";
import { ContextService } from "../core/context.js";
import {
  ContinuityStore,
  CreateHandoffInputSchema,
  GetHandoffInputSchema,
  GetTaskInputSchema,
  ListHandoffsInputSchema,
  ListTasksInputSchema,
  UpsertTaskInputSchema,
} from "../core/continuity.js";
import { buildProjectBriefing } from "../core/briefing.js";
import { MCP_SERVER_INSTRUCTIONS, TOOL_DEFS, WRITE_TOOLS, canonicalToolName, type ToolDef } from "./tools.js";
import type { ResolvedConfig } from "../core/types.js";

export const SERVER_NAME = "consistorium";
export const SERVER_VERSION = "0.4.0";

export interface BridgeRuntime {
  config: ResolvedConfig;
  policy: SecurityPolicy;
  service: ContextService;
  continuity: ContinuityStore;
  allowWrites: boolean;
  noConfig: boolean;
}

export interface BootstrapOptions {
  allowWrites?: boolean;
  configPath?: string;
  stateDir?: string;
}

function emptyResolved(syntheticPath: string): ResolvedConfig {
  return {
    version: 1,
    projects: [],
    sessionArtifacts: { patterns: [] },
    search: { maxResults: 100, maxFileSizeBytes: 512 * 1024 },
    limits: { maxFileSizeBytes: 256 * 1024, maxDiffBytes: 128 * 1024, maxSearchResults: 100 },
    configPath: syntheticPath,
    observedAt: new Date().toISOString(),
  };
}

export function bootstrap(options: BootstrapOptions = {}): BridgeRuntime {
  const explicit = options.configPath ?? process.env.CONTEXT_BRIDGE_CONFIG;
  const foundPath = explicit ? explicit : findConfigFile() ?? null;

  let resolved: ResolvedConfig;
  let noConfig = false;

  if (!foundPath) {
    const syntheticPath = process.env.PLUGIN_DATA
      ? `${process.env.PLUGIN_DATA}/config.yaml`
      : `${process.cwd()}/context-bridge.yaml`;
    try {
      resolved = resolveConfigSync(
        { version: 1, projects: [] as { name: string; path: string; context: string[] }[], sessionArtifacts: { patterns: [] as string[] } } as unknown as import("../core/types.js").RawConfig,
        syntheticPath
      );
    } catch {
      resolved = emptyResolved(syntheticPath);
    }
    noConfig = true;
  } else {
    const { raw, filePath } = loadConfigSync(foundPath);
    resolved = resolveConfigSync(raw, filePath);
  }

  const roots = resolved.projects.map((p) => p.canonicalPath).filter(Boolean);
  const policy = new SecurityPolicy(roots.length ? roots : ["/tmp/context-bridge-empty"]);
  const service = new ContextService(resolved, policy);
  const continuity = new ContinuityStore(resolved, options.stateDir ? { stateDir: options.stateDir } : undefined);

  return {
    config: resolved,
    policy,
    service,
    continuity,
    allowWrites: options.allowWrites !== false,
    noConfig,
  };
}

function toMcpError(e: unknown): { code: string; message: string; details?: unknown } {
  const err = e as Error & { code?: string; details?: unknown };
  return {
    code: err.code ?? "INTERNAL_ERROR",
    message: err.message ?? String(e),
    details: err.details,
  };
}

function parseArgs<T extends z.ZodTypeAny>(schema: T, raw: Record<string, unknown>): z.infer<T> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data as z.infer<T>;
  const details = result.error.issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message }));
  throw Object.assign(new Error("invalid tool arguments"), { code: "INVALID_ARG", details });
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw Object.assign(new Error(`${key} must be a non-empty string`), { code: "INVALID_ARG" });
  }
  return value;
}

function optionalInteger(args: Record<string, unknown>, key: string, min?: number, max?: number): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw Object.assign(new Error(`${key} must be an integer`), { code: "INVALID_ARG" });
  }
  if (min !== undefined && value < min) {
    throw Object.assign(new Error(`${key} must be at least ${min}`), { code: "INVALID_ARG" });
  }
  if (max !== undefined && value > max) {
    throw Object.assign(new Error(`${key} must be at most ${max}`), { code: "INVALID_ARG" });
  }
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw Object.assign(new Error(`${key} must be a boolean`), { code: "INVALID_ARG" });
  }
  return value;
}

export function noConfigMessage(config: ResolvedConfig): string {
  return (
    `No Consistorium configuration found. ` +
    `Searched default locations and ${config.configPath}. ` +
    `Run 'consistorium init' to create a configuration, or set CONTEXT_BRIDGE_CONFIG to the config path.`
  );
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

function ok(value: unknown): ToolResult {
  return { text: JSON.stringify(value, null, 2) };
}

function fail(message: string, extra?: Record<string, unknown>): ToolResult {
  return { text: JSON.stringify({ error: message, ...extra }, null, 2), isError: true };
}

export function visibleTools(allowWrites: boolean): ToolDef[] {
  if (allowWrites) return TOOL_DEFS;
  return TOOL_DEFS.filter((tool) => !WRITE_TOOLS.has(tool.name));
}

export async function dispatchTool(
  runtime: BridgeRuntime,
  requestedName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const { config, service, continuity } = runtime;
  // Accept the pre-0.3 dotted tool names from existing clients.
  const name = canonicalToolName(requestedName);

  if (WRITE_TOOLS.has(name) && !runtime.allowWrites) {
    return fail("Write tools are disabled on this transport. Use the local stdio server to record tasks and handoffs.", {
      code: "WRITE_DISABLED",
      tool: name,
    });
  }

  if (runtime.noConfig && name !== "context_list_agent_sessions" && name !== "context_session_snapshot") {
    if (name === "context_list_projects") {
      return fail(noConfigMessage(config), { projects: [] });
    }
    return fail(noConfigMessage(config));
  }

  switch (name) {
    case "context_list_projects": {
      const projects = await service.listProjects();
      return ok({ projects, provenance: { observedAt: new Date().toISOString() } });
    }

    case "context_project_briefing": {
      const project = requiredString(args, "project");
      const recentLimit = optionalInteger(args, "recentLimit", 1, 20);
      const includeDocuments = optionalBoolean(args, "includeDocuments") ?? true;
      const briefing = await buildProjectBriefing(service, continuity, project, { recentLimit, includeDocuments });
      return ok(briefing);
    }

    case "context_task_upsert": {
      const input = parseArgs(UpsertTaskInputSchema, args);
      const task = await continuity.upsertTask(input);
      return ok({ task });
    }

    case "context_task_list": {
      const input = parseArgs(ListTasksInputSchema, args);
      const result = await continuity.listTasks(input);
      return ok(result);
    }

    case "context_task_get": {
      const input = parseArgs(GetTaskInputSchema, args);
      const task = await continuity.getTask(input);
      return ok({ task });
    }

    case "context_handoff_create": {
      const input = parseArgs(CreateHandoffInputSchema, args);
      const handoff = await continuity.createHandoff(input);
      return ok({ handoff });
    }

    case "context_handoff_list": {
      const input = parseArgs(ListHandoffsInputSchema, args);
      const result = await continuity.listHandoffs(input);
      return ok(result);
    }

    case "context_handoff_get": {
      const input = parseArgs(GetHandoffInputSchema, args);
      const handoff = await continuity.getHandoff(input);
      return ok({ handoff });
    }

    case "context_project_snapshot": {
      const project = requiredString(args, "project");
      const recentLimit = optionalInteger(args, "recentLimit", 1, 100);
      const includeSessions = optionalBoolean(args, "includeSessions") ?? true;
      const snap = await service.projectSnapshot(project, { recentLimit, includeSessions });
      return ok(snap);
    }

    case "context_list_worktrees": {
      const project = requiredString(args, "project");
      const wts = await service.listWorktrees(project);
      return ok({ worktrees: wts, provenance: { observedAt: new Date().toISOString(), projectName: project } });
    }

    case "context_worktree_snapshot": {
      const project = requiredString(args, "project");
      const wtPath = requiredString(args, "path");
      const snap = await service.worktreeSnapshot(project, wtPath);
      return ok(snap);
    }

    case "context_recent_changes": {
      const project = requiredString(args, "project");
      const limit = optionalInteger(args, "limit", 1, 100);
      const worktreePath = args.worktreePath !== undefined ? requiredString(args, "worktreePath") : undefined;
      const includeDiffStat = optionalBoolean(args, "includeDiffStat") ?? true;
      const rc = await service.recentChanges(project, { limit, worktreePath, includeDiffStat });
      return ok({ ...rc, provenance: { observedAt: new Date().toISOString(), projectName: project } });
    }

    case "context_compare": {
      const project = requiredString(args, "project");
      const base = requiredString(args, "base");
      const target = requiredString(args, "target");
      const includeDiff = optionalBoolean(args, "includeDiff") ?? false;
      const maxDiffBytes = optionalInteger(args, "maxDiffBytes", 1024, 500 * 1024);
      const worktreePath = args.worktreePath !== undefined ? requiredString(args, "worktreePath") : undefined;
      const cmp = await service.compare(project, base, target, { includeDiff, maxDiffBytes, worktreePath });
      return ok(cmp);
    }

    case "context_search": {
      const project = requiredString(args, "project");
      const query = requiredString(args, "query");
      const maxResults = optionalInteger(args, "maxResults", 1, 500);
      const caseSensitive = optionalBoolean(args, "caseSensitive");
      const res = await service.search(project, query, { maxResults, caseSensitive });
      return ok(res);
    }

    case "context_list_context_documents": {
      const project = requiredString(args, "project");
      const docs = await service.listContextDocuments(project);
      return ok({ documents: docs, provenance: { observedAt: new Date().toISOString(), projectName: project } });
    }

    case "context_read_context_document": {
      const project = requiredString(args, "project");
      const docPath = requiredString(args, "path");
      const maxBytes = optionalInteger(args, "maxBytes", 1, 1024 * 1024);
      const content = await service.readContextDocument(project, docPath, { maxBytes });
      return ok(content);
    }

    case "context_list_agent_sessions": {
      const project = args.project !== undefined ? requiredString(args, "project") : undefined;
      const sessions = await service.listAgentSessions(project);
      return ok({ sessions, provenance: { observedAt: new Date().toISOString() } });
    }

    case "context_session_snapshot": {
      const id = requiredString(args, "id");
      const snap = await service.sessionSnapshot(id);
      if (!snap) return fail(`Session not found: ${id}`);
      return ok(snap);
    }

    default:
      return fail(`Unknown tool: ${name}`);
  }
}

export function createMcpServer(runtime: BridgeRuntime): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: MCP_SERVER_INSTRUCTIONS,
    }
  );

  const tools = visibleTools(runtime.allowWrites);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;
    try {
      const result = await dispatchTool(runtime, name, a);
      return {
        content: [{ type: "text", text: result.text }],
        isError: result.isError,
      };
    } catch (e) {
      const err = toMcpError(e);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message, code: err.code, details: err.details }, null, 2) }],
        isError: true,
      };
    }
  });

  return server;
}
