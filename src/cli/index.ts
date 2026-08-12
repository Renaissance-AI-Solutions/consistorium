#!/usr/bin/env node
/**
 * context-bridge CLI — init, config validation, and helpers.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import * as yaml from "yaml";
import { loadConfigSync, resolveConfigSync, getDefaultConfigPaths } from "../core/config.js";

const VERSION = "0.1.0";

function printHelp(): void {
  console.log(`
Context Bridge v${VERSION} — vendor-neutral task/handoff continuity + bounded repository observation

Usage:
  context-bridge <command> [options]

Commands:
  init                  Initialize a new configuration interactively or with flags
  config show           Show resolved configuration
  config validate       Validate configuration file
  serve                 Start MCP stdio server (same as running without args via MCP)
  version               Print version
  help                  Show this help

Init options:
  --path <dir>          Project path to allowlist (can be repeated)
  --name <name>         Project name (paired with --path; defaults to directory basename)
  --output <file>       Config output path (default: ~/.config/context-bridge/config.yaml)
  --context <glob>      Context-document glob (can be repeated)
  --session <glob>      Session-artifact glob (can be repeated)
  --yes                 Non-interactive, use defaults where possible
  --force               Overwrite existing config

Examples:
  context-bridge init
  context-bridge init --path ~/dev/my-project --context "TODO.md" --context "docs/** /*.md"
  context-bridge config show
  context-bridge config validate --config ./context-bridge.yaml

Environment:
  CONTEXT_BRIDGE_CONFIG   Explicit config file path
  CONTEXT_BRIDGE_STATE_DIR Explicit local task/handoff state directory (otherwise derived outside projects)
  PLUGIN_DATA             Plugin data directory (overrides default config location)
`.trim());
}

async function prompt(question: string, defaultVal?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

function getDefaultConfigPath(): string {
  if (process.env.PLUGIN_DATA) {
    return path.join(process.env.PLUGIN_DATA, "config.yaml");
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "context-bridge", "config.yaml");
}

function parseInitArgs(argv: string[]): {
  paths: string[];
  names: string[];
  output?: string;
  contexts: string[];
  sessions: string[];
  yes: boolean;
  force: boolean;
} {
  const paths: string[] = [];
  const names: string[] = [];
  const contexts: string[] = [];
  const sessions: string[] = [];
  let output: string | undefined;
  let yes = false;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--path" && argv[i + 1]) paths.push(argv[++i]!);
    else if (arg === "--name" && argv[i + 1]) names.push(argv[++i]!);
    else if (arg === "--output" && argv[i + 1]) output = argv[++i]!;
    else if (arg === "--context" && argv[i + 1]) contexts.push(argv[++i]!);
    else if (arg === "--session" && argv[i + 1]) sessions.push(argv[++i]!);
    else if (arg === "--yes") yes = true;
    else if (arg === "--force") force = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return { paths, names, output, contexts, sessions, yes, force };
}

async function cmdInit(argv: string[]): Promise<void> {
  const opts = parseInitArgs(argv);
  let outputPath = opts.output ?? getDefaultConfigPath();

  // Check existing
  if (fs.existsSync(outputPath) && !opts.force) {
    if (opts.yes) {
      console.error(`Config already exists at ${outputPath}. Use --force to overwrite.`);
      process.exit(1);
    }
    const ans = await prompt(`Config already exists at ${outputPath}. Overwrite? (y/N)`, "N");
    if (!ans.toLowerCase().startsWith("y")) {
      console.log("Aborted.");
      return;
    }
  }

  // Gather projects
  interface Proj { name: string; path: string; context: string[] }
  const projects: Proj[] = [];

  if (opts.paths.length > 0) {
    for (let i = 0; i < opts.paths.length; i++) {
      const p = opts.paths[i]!;
      const n = opts.names[i] ?? path.basename(path.resolve(p.replace(/^~/, os.homedir())));
      let abs: string;
      try {
        abs = await fs.promises.realpath(path.resolve(p.replace(/^~/, os.homedir())));
      } catch {
        abs = path.resolve(p.replace(/^~/, os.homedir()));
      }
      projects.push({
        name: n,
        path: abs,
        context: opts.contexts.length ? [...opts.contexts] : ["TODO.md", "ROADMAP.md", "docs/**/*.md", "reports/**/*.md"],
      });
    }
  } else if (opts.yes) {
    // Non-interactive with no --path: use cwd
    const cwd = process.cwd();
    let abs: string;
    try {
      abs = await fs.promises.realpath(cwd);
    } catch {
      abs = cwd;
    }
    projects.push({
      name: path.basename(abs),
      path: abs,
      context: opts.contexts.length ? [...opts.contexts] : ["TODO.md", "ROADMAP.md", "docs/**/*.md"],
    });
  } else {
    // Interactive mode
    console.log("Context Bridge — initialization\n");
    console.log("You will explicitly allowlist project roots. Only these directories will be inspected.\n");

    let addMore = true;
    while (addMore) {
      const defaultPath = projects.length === 0 ? process.cwd() : "";
      const p = await prompt(`Project path${projects.length ? " (leave empty to finish)" : ""}`, defaultPath);
      if (!p && projects.length > 0) break;
      if (!p) {
        console.log("Please enter a project path.");
        continue;
      }
      const expanded = p.replace(/^~/, os.homedir());
      const abs = path.resolve(expanded);
      let canonical: string;
      try {
        canonical = await fs.promises.realpath(abs);
      } catch {
        console.log(`  Warning: path does not exist or not accessible: ${abs}`);
        if (projects.length === 0) {
          const useAnyway = await prompt("Use this path anyway? (y/N)", "N");
          if (!useAnyway.toLowerCase().startsWith("y")) continue;
        }
        canonical = abs;
      }

      // Check exists
      try {
        const st = await fs.promises.stat(canonical);
        if (!st.isDirectory()) {
          console.log(`  Not a directory: ${canonical}`);
          continue;
        }
      } catch {
        // already warned
      }

      const defaultName = path.basename(canonical);
      const name = await prompt("  Project name", defaultName);
      const finalName = name || defaultName;

      // Context patterns
      const ctxInput = await prompt(
        "  Context-document globs (comma-separated)",
        "TODO.md, ROADMAP.md, docs/**/*.md"
      );
      const ctxPatterns = ctxInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      projects.push({ name: finalName, path: canonical, context: ctxPatterns });

      const more = await prompt("Add another project? (y/N)", "N");
      addMore = more.toLowerCase().startsWith("y");
    }

    if (projects.length === 0) {
      console.error("No projects configured. Aborting.");
      process.exit(1);
    }

    // Session artifacts
    const sessInput = await prompt(
      "Session-artifact globs (comma-separated, leave empty for none)",
      ""
    );
    if (sessInput) {
      const sessPatterns = sessInput.split(",").map((s) => s.trim()).filter(Boolean);
      opts.sessions.push(...sessPatterns);
    }

    // Output path
    const out = await prompt("Config output path", outputPath);
    if (out) outputPath = path.resolve(out.replace(/^~/, os.homedir()));
  }

  // Build raw config
  const raw: Record<string, unknown> = {
    version: 1,
    projects: projects.map((p) => ({
      name: p.name,
      path: p.path,
      context: p.context,
    })),
  };
  if (opts.sessions.length > 0) {
    (raw as Record<string, unknown>).sessionArtifacts = { patterns: opts.sessions };
  }

  // Validate via resolve
  const tmpFile = outputPath;
  // Temporarily write to validate (or just call resolveConfigSync with synthetic)
  const yamlStr = yaml.stringify(raw, { indent: 2 });

  // Ensure parent dir exists
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, yamlStr, "utf-8");

  // Validate by reloading
  try {
    const { raw: loaded } = loadConfigSync(outputPath);
    resolveConfigSync(loaded, outputPath);
  } catch (e) {
    // Remove broken file
    try {
      await fs.promises.unlink(outputPath);
    } catch { /* ignore */ }
    throw e;
  }

  console.log(`\n✓ Configuration written to ${outputPath}`);
  console.log(`  Projects: ${projects.map((p) => p.name).join(", ")}`);
  if (opts.sessions.length > 0) console.log(`  Session patterns: ${opts.sessions.join(", ")}`);
  console.log(`\nNext steps:`);
  console.log(`  - Review: cat ${outputPath}`);
  console.log(`  - Validate: context-bridge config validate --config ${outputPath}`);
  console.log(`  - Start MCP server: context-bridge serve (or configure your MCP client)`);
}

async function cmdConfigShow(args: string[]): Promise<void> {
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--config" || args[i] === "-c") && args[i + 1]) configPath = args[++i];
  }
  const explicit = configPath ?? process.env.CONTEXT_BRIDGE_CONFIG;
  const { raw, filePath } = loadConfigSync(explicit);
  const resolved = resolveConfigSync(raw, filePath);
  console.log(yaml.stringify(resolved, { indent: 2 }));
}

async function cmdConfigValidate(args: string[]): Promise<void> {
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--config" || args[i] === "-c") && args[i + 1]) configPath = args[++i];
  }
  const explicit = configPath ?? process.env.CONTEXT_BRIDGE_CONFIG;
  try {
    const { raw, filePath } = loadConfigSync(explicit);
    const resolved = resolveConfigSync(raw, filePath);
    console.log(`✓ Config valid: ${filePath}`);
    console.log(`  Projects: ${resolved.projects.length} (${resolved.projects.map((p) => p.name).join(", ")})`);
    console.log(`  Session patterns: ${resolved.sessionArtifacts.patterns.length}`);
  } catch (e) {
    console.error(`✗ Config invalid: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "init") {
    await cmdInit(rest);
    return;
  }
  if (cmd === "config") {
    const sub = rest[0];
    if (sub === "show") await cmdConfigShow(rest.slice(1));
    else if (sub === "validate") await cmdConfigValidate(rest.slice(1));
    else {
      console.error(`Unknown config subcommand: ${sub}`);
      printHelp();
      process.exit(1);
    }
    return;
  }
  if (cmd === "serve") {
    // Dynamic import to avoid circular issues
    await import("../mcp/server.js");
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

main().catch((e) => {
  console.error("Error:", (e as Error).message);
  process.exit(1);
});
