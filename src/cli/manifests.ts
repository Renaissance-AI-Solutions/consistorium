import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

// Offline equivalents of the Agent Plugins 1.0.0 machine-readable schemas:
// https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
// https://agent-plugins.org/schemas/1.0.0/mcp.schema.json
// These validate shape only; they do not execute servers or resolve variables.
const pluginSchema = z.object({
  $schema: z.literal("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"),
  name: z.string().min(1).max(64).regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    url: z.string().optional(),
  }).strict().optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  extensions: z.record(z.object({}).passthrough()).optional(),
}).strict();

const stdioSchema = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string().refine((key) => key !== "PLUGIN_ROOT" && key !== "PLUGIN_DATA", {
    message: "Reserved plugin environment variable",
  }), z.string()).optional(),
  cwd: z.string().regex(/^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/).optional(),
}).strict();
const httpFields = {
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
};
const mcpSchema = z.object({
  $schema: z.literal("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"),
  mcpServers: z.record(z.discriminatedUnion("type", [
    stdioSchema,
    z.object({ type: z.literal("streamable-http"), ...httpFields }).strict(),
    z.object({ type: z.literal("sse"), ...httpFields }).strict(),
  ])),
}).strict();

export interface ManifestCheck {
  file: "plugin.json" | "mcp.json";
  errors: string[];
}

/** Check the installed package, independent of the caller's working directory.
 * Diagnostics intentionally omit input values (env/headers may hold secrets).
 */
export function checkPluginManifests(packageRoot: string): ManifestCheck[] {
  return ([
    ["plugin.json", pluginSchema],
    ["mcp.json", mcpSchema],
  ] as const).map(([file, schema]) => {
    let source: string;
    try {
      source = fs.readFileSync(path.join(packageRoot, file), "utf8");
    } catch (error) {
      return { file, errors: [`Cannot read file (${(error as NodeJS.ErrnoException).code ?? "I/O error"})`] };
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      return { file, errors: ["Invalid JSON"] };
    }
    const result = schema.safeParse(value);
    return {
      file,
      errors: result.success ? [] : result.error.issues.map((issue) =>
        `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.code}`),
    };
  });
}
