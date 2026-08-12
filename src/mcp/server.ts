#!/usr/bin/env node
/**
 * Context Bridge MCP server — stdio transport.
 *
 * Loads configuration, constructs SecurityPolicy + ContextService,
 * and exposes tools over MCP.
 *
 * Transport-agnostic core: ContextService can be reused for Streamable HTTP later.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfigSync, resolveConfigSync, findConfigFile } from "../core/config.js";
import { SecurityPolicy } from "../core/security.js";
import { ContextService } from "../core/context.js";
import { TOOL_DEFS } from "./tools.js";
import type { ResolvedConfig } from "../core/types.js";

// ---------------------------------------------------------------------------
// Bootstrap config
// ---------------------------------------------------------------------------

function bootstrap(): { config: ResolvedConfig; policy: SecurityPolicy; service: ContextService } {
  const explicit = process.env.CONTEXT_BRIDGE_CONFIG;
  const foundPath = explicit ? explicit : findConfigFile() ?? null;

  let resolved: ResolvedConfig;

  if (!foundPath) {
    // No config found — create an ephemeral empty config so the server can still start
    // and report a helpful error via tools. But we prefer to fail fast with guidance.
    // Instead, create a minimal config that will cause tool calls to explain how to init.
    const tmpConfig = {
      version: 1,
      projects: [] as { name: string; path: string; context: string[] }[],
      sessionArtifacts: { patterns: [] as string[] },
    };
    // We can't resolve without a real file path; use a synthetic one
    const syntheticPath = process.env.PLUGIN_DATA
      ? `${process.env.PLUGIN_DATA}/config.yaml`
      : `${process.cwd()}/context-bridge.yaml`;
    // Use resolveConfigSync with synthetic path (it won't check existence of project paths that are empty)
    // If no projects, this is okay — tools will return empty / error.
    try {
      resolved = resolveConfigSync(tmpConfig as unknown as import("../core/types.js").RawConfig, syntheticPath);
    } catch {
      // fallback minimal
      resolved = {
        version: 1,
        projects: [],
        sessionArtifacts: { patterns: [] },
        search: { maxResults: 100, maxFileSizeBytes: 512 * 1024 },
        limits: { maxFileSizeBytes: 256 * 1024, maxDiffBytes: 128 * 1024, maxSearchResults: 100 },
        configPath: syntheticPath,
        observedAt: new Date().toISOString(),
      };
    }
    // Mark that config is missing
    (resolved as unknown as Record<string, unknown>).__noConfig = true;
    (resolved as unknown as Record<string, unknown>).__searched = foundPath;
  } else {
    const { raw, filePath } = loadConfigSync(foundPath);
    resolved = resolveConfigSync(raw, filePath);
  }

  const roots = resolved.projects.map((p) => p.canonicalPath).filter(Boolean);
  // If no projects, allow no roots (policy will deny everything — tools will explain)
  const policy = new SecurityPolicy(roots.length ? roots : ["/tmp/context-bridge-empty"]);
  const service = new ContextService(resolved, policy);

  return { config: resolved, policy, service };
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

function toMcpError(e: unknown): { code: string; message: string } {
  const err = e as Error & { code?: string };
  return {
    code: err.code ?? "INTERNAL_ERROR",
    message: err.message ?? String(e),
  };
}

function noConfigMessage(config: ResolvedConfig): string {
  return (
    `No Context Bridge configuration found. ` +
    `Searched default locations and ${config.configPath}. ` +
    `Run 'context-bridge init' to create a configuration, or set CONTEXT_BRIDGE_CONFIG to the config path.`
  );
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function main() {
  const { config, service } = bootstrap();

  const server = new Server(
    {
      name: "context-bridge",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOL_DEFS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  // Empty handlers for prompts/resources to avoid "method not found" noise
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    // If no config and project is required, return a helpful error
    const isNoConfig = (config as unknown as Record<string, unknown>).__noConfig === true;

    try {
      switch (name) {
        case "context.list_projects": {
          if (isNoConfig) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: noConfigMessage(config), projects: [] }, null, 2) }],
              isError: true,
            };
          }
          const projects = await service.listProjects();
          return {
            content: [{ type: "text", text: JSON.stringify({ projects, provenance: { observedAt: new Date().toISOString() } }, null, 2) }],
          };
        }

        case "context.project_snapshot": {
          if (isNoConfig) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: noConfigMessage(config) }, null, 2) }],
              isError: true,
            };
          }
          const project = String(a.project ?? "");
          if (!project) throw Object.assign(new Error("project is required"), { code: "INVALID_ARG" });
          const recentLimit = a.recentLimit !== undefined ? Number(a.recentLimit) : undefined;
          const includeSessions = a.includeSessions !== undefined ? Boolean(a.includeSessions) : true;
          const snap = await service.projectSnapshot(project, { recentLimit, includeSessions });
          return { content: [{ type: "text", text: JSON.stringify(snap, null, 2) }] };
        }

        case "context.list_worktrees": {
          if (isNoConfig) return { content: [{ type: "text", text: JSON.stringify({ error: noConfigMessage(config) }, null, 2) }], isError: true };
          const project = String(a.project ?? "");
          if (!project) throw Object.assign(new Error("project is required"), { code: "INVALID_ARG" });
          const wts = await service.listWorktrees(project);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ worktrees: wts, provenance: { observedAt: new Date().toISOString(), projectName: project } }, null, 2),
              },
            ],
          };
        }

        case "context.worktree_snapshot": {
          if (isNoConfig) return { content: [{ type: "text", text: JSON.stringify({ error: noConfigMessage(config) }, null, 2) }], isError: true };
          const project = String(a.project ?? "");
          const wtPath = String(a.path ?? "");
          if (!project || !wtPath) throw Object.assign(new Error("project and path are required"), { code: "INVALID_ARG" });
          const snap = await service.worktreeSnapshot(project, wtPath);
          return { content: [{ type: "text", text: JSON.stringify(snap, null, 2) }] };
        }

        case "context.recent_changes": {
          if (isNoConfig) return { content: [{ type: "text", text: JSON.stringify({ error: noConfigMessage(config) }, null, 2) }], isError: true };
          const project = String(a.project ?? "");
          if (!project) throw Object.assign(new Error("project is required"), { code: "INVALID_ARG" });
          const limit = a.limit !== undefined ? Number(a.limit) : undefined;
          const worktreePath = a.worktreePath ? String(a.worktreePath) : undefined;
          const includeDiffStat = a.includeDiffStat !== undefined ? Boolean(a.includeDiffStat) : true;
          const rc = await service.recentChanges(project, { limit, worktreePath, includeDiffStat });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ...rc, provenance: { observedAt: new Date().toISOString(), projectName: project } }, null, 2),
              },
            ],
          };
        }

        case "context.compare": {
          if (isNoConfig) return { content: [{ type: "text", text: JSON.stringify({ error: noConfigMessage(config) }, null, 2) }], isError: true };
          const project = String(a.project ?? "");
          const base = String(a.base ?? "");
          const target = String(a.target ?? "");
          if (!project || !base || !target) throw Object.assign(new Error("project, base, and target are required"), { code: "INVALID_ARG" });
          const includeDiff = Boolean(a.includeDiff);
          const maxDiffBytes = a.maxDiffBytes !== undefined ? Number(a.maxDiffBytes) : undefined;
          const worktreePath = a.worktreePath ? String(a.worktreePath) : undefined;
          const cmp = await service.compare(project, base, target, { includeDiff, maxDiffBytes, worktreePath });
          return { content: [{ type: "text", text: JSON.stringify(cmp, null, 2) }] };
        }

        case "context.search": {
          if (isNoConfig) return { content: [{ type: "text", text: JSON.stringify({ error: noConfigMessage(config) }, null, 2) }], isError: true };
          const project = String(a.project ?? "");
          const query = String(a.query ?? "");
          if (!project || !query) throw Object.assign(new Error("project and query are required"), { code: "INVALID_ARG" });
          const maxResults = a.maxResults !== undefined ? Number(a.maxResults) : undefined;
          const caseSensitive = a.caseSensitive !== undefined ? Boolean(a.caseSensitive) : undefined;
          const res = await service.search(project, query, { maxResults, caseSensitive });
          return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
        }

        case "context.list_context_documents": {
          if (isNoConfig) return { content: [{ type: "text", text: JSON.stringify({ error: noConfigMessage(config) }, null, 2) }], isError: true };
          const project = String(a.project ?? "");
          if (!project) throw Object.assign(new Error("project is required"), { code: "INVALID_ARG" });
          const docs = await service.listContextDocuments(project);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ documents: docs, provenance: { observedAt: new Date().toISOString(), projectName: project } }, null, 2),
              },
            ],
          };
        }

        case "context.read_context_document": {
          if (isNoConfig) return { content: [{ type: "text", text: JSON.stringify({ error: noConfigMessage(config) }, null, 2) }], isError: true };
          const project = String(a.project ?? "");
          const docPath = String(a.path ?? "");
          if (!project || !docPath) throw Object.assign(new Error("project and path are required"), { code: "INVALID_ARG" });
          const maxBytes = a.maxBytes !== undefined ? Number(a.maxBytes) : undefined;
          const content = await service.readContextDocument(project, docPath, { maxBytes });
          return { content: [{ type: "text", text: JSON.stringify(content, null, 2) }] };
        }

        case "context.list_agent_sessions": {
          // list_agent_sessions works even with no config (returns empty)
          const project = a.project ? String(a.project) : undefined;
          const sessions = await service.listAgentSessions(project);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ sessions, provenance: { observedAt: new Date().toISOString() } }, null, 2),
              },
            ],
          };
        }

        case "context.session_snapshot": {
          const id = String(a.id ?? "");
          if (!id) throw Object.assign(new Error("id is required"), { code: "INVALID_ARG" });
          const snap = await service.sessionSnapshot(id);
          if (!snap) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: `Session not found: ${id}` }, null, 2) }],
              isError: true,
            };
          }
          return { content: [{ type: "text", text: JSON.stringify(snap, null, 2) }] };
        }

        default:
          return {
            content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }, null, 2) }],
            isError: true,
          };
      }
    } catch (e) {
      const err = toMcpError(e);
      // Return as MCP error content, not thrown, so the client gets structured JSON
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err.message, code: err.code }, null, 2) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so we don't pollute stdio JSON-RPC
  console.error(`[context-bridge] MCP server running. Config: ${config.configPath} Projects: ${config.projects.length}`);
}

main().catch((e) => {
  console.error("[context-bridge] Fatal:", e);
  process.exit(1);
});
