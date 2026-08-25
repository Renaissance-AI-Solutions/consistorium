#!/usr/bin/env node
/**
 * Consistorium CLI — init, config validation, and helpers.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import * as yaml from "yaml";
import { loadConfigSync, resolveConfigSync, getDefaultConfigPaths, findConfigFile } from "../core/config.js";
import { resolveStateDir } from "../core/continuity.js";
import { bootstrap } from "../mcp/app.js";
import { generateToken, startHttpServer, validateHttpOptions } from "../mcp/http.js";
import { buildProjectBriefing } from "../core/briefing.js";

const VERSION = "0.4.0";

function printHelp(): void {
  console.log(`
Consistorium v${VERSION} — vendor-neutral task/handoff continuity + bounded repository observation

Usage:
  consistorium <command> [options]

Commands:
  init                  Initialize a new configuration interactively or with flags
  config show           Show resolved configuration
  config validate       Validate configuration file
  serve                 Start MCP stdio server (default)
  serve --read-only     Start MCP stdio without task/handoff write tools
  serve --http          Start ChatGPT-compatible Streamable HTTP on /mcp
  doctor                Check config, state dir, and smoke a project briefing
  mcp-snippet           Print a ready-to-paste MCP registration for a client
  autostart             Install/remove a per-user launcher for the tunnel runtime
  token                 Generate a bearer token for the HTTP transport
  version               Print version
  help                  Show this help

HTTP serve options:
  --host <addr>         Bind address (default 127.0.0.1)
  --port <n>            Port (default 8787)
  --token <token>       Bearer token (or CONSISTORIUM_TOKEN)
  --allow-anonymous     Loopback only: allow unauthenticated HTTP
  --allow-writes        Expose task/handoff write tools on HTTP (off by default)
  --allowed-host <h>    Extra Host header value (repeatable; required mindset for non-loopback)

Init options:
  --path <dir>          Project path to allowlist (can be repeated)
  --name <name>         Project name (paired with --path; defaults to directory basename)
  --output <file>       Config output path (default: ~/.config/consistorium/config.yaml)
  --context <glob>      Context-document glob (can be repeated)
  --session <glob>      Session-artifact glob (can be repeated)
  --yes                 Non-interactive, use defaults where possible
  --force               Overwrite existing config

Examples:
  consistorium init
  consistorium init --path ~/dev/my-project --context "TODO.md" --context "docs/**/*.md"
  consistorium config show
  consistorium config validate --config ./consistorium.yaml
  consistorium mcp-snippet --client claude-code
  consistorium mcp-snippet --client cursor --config ~/.config/consistorium/config.yaml
  consistorium autostart install --alias consistorium   # keep the ChatGPT tunnel runtime alive across reboots
  consistorium autostart remove --alias consistorium

Environment:
  CONSISTORIUM_CONFIG        Explicit config file path (pre-0.4 CONTEXT_BRIDGE_CONFIG still honored)
  CONSISTORIUM_STATE_DIR     Explicit local task/handoff state directory (otherwise derived outside projects)
  CONSISTORIUM_TOKEN         Bearer token required by the HTTP transport (pre-0.4 name still honored)
  CONSISTORIUM_HTTP_WRITES=1 Same as --allow-writes
  PLUGIN_DATA                Plugin data directory (overrides default config location)
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
  return path.join(xdg, "consistorium", "config.yaml");
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
        context: opts.contexts.length ? [...opts.contexts] : ["README.md", "DESIGN.md", "TODO.md", "ROADMAP.md", "docs/**/*.md", "reports/**/*.md"],
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
      context: opts.contexts.length ? [...opts.contexts] : ["README.md", "DESIGN.md", "TODO.md", "ROADMAP.md", "docs/**/*.md"],
    });
  } else {
    // Interactive mode
    console.log("Consistorium — initialization\n");
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
        "README.md, DESIGN.md, TODO.md, ROADMAP.md, docs/**/*.md"
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
  const absConfigPath = path.resolve(outputPath);
  console.log(`
Next steps:
  - Verify: consistorium doctor
  - Register your MCP client with this snippet (restart the client afterwards):

${JSON.stringify({ mcpServers: { consistorium: buildServerEntry(resolveCliCommandPath(), ["serve"], absConfigPath) } }, null, 2)
  .split("\n")
  .map((l) => `    ${l}`)
  .join("\n")}

  Or generate a ready-to-run command for your specific client:
    consistorium mcp-snippet --client claude-code   (also: cursor, windsurf, claude-desktop, codex, generic)
`.trim());
}

async function cmdConfigShow(args: string[]): Promise<void> {
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--config" || args[i] === "-c") && args[i + 1]) configPath = args[++i];
  }
  const explicit =
    configPath ??
    process.env.CONSISTORIUM_CONFIG ??
    process.env.CONTEXT_BRIDGE_CONFIG;
  const { raw, filePath } = loadConfigSync(explicit);
  const resolved = resolveConfigSync(raw, filePath);
  console.log(yaml.stringify(resolved, { indent: 2 }));
}

async function cmdConfigValidate(args: string[]): Promise<void> {
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--config" || args[i] === "-c") && args[i + 1]) configPath = args[++i];
  }
  const explicit =
    configPath ??
    process.env.CONSISTORIUM_CONFIG ??
    process.env.CONTEXT_BRIDGE_CONFIG;
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

/**
 * Per-user autostart for the managed tunnel runtime (the ChatGPT path).
 *
 * The tunnel-client runtime must be running for ChatGPT discovery and every tool call, but it
 * does not survive reboots on its own. `autostart install` writes a per-user launcher that
 * re-runs the exact `runtimes connect` command at login (and periodically). Nothing
 * system-wide is touched and no key material appears in the launcher file — it references the
 * existing owner-only key file.
 */
function buildConnectShell(alias: string, tunnelId: string, keyFile: string, bin: string): string {
  // Idempotent: skip when tunnel-client is missing or the runtime is already ready.
  return [
    `command -v tunnel-client >/dev/null 2>&1 || exit 0`,
    `tunnel-client runtimes status ${alias} --json 2>/dev/null | grep -q '"ready":true' && exit 0`,
    `tunnel-client runtimes connect --alias ${alias} --profile consistorium-managed --tunnel-id ${tunnelId} --runtime-api-key 'file:${keyFile}' --mcp-command '${bin} serve --read-only' --json`,
  ].join("; ");
}

async function cmdAutostart(args: string[]): Promise<void> {
  const action = args[0];
  const alias = readFlag(args, "--alias") ?? "consistorium";
  const tunnelId = readFlag(args, "--tunnel-id");
  const keyFlag = readFlag(args, "--key-file");

  if (action !== "install" && action !== "remove") {
    console.error("Usage: consistorium autostart <install|remove> [--alias consistorium] [--tunnel-id tunnel_...] [--key-file <path>]");
    process.exit(1);
  }

  const isMac = process.platform === "darwin";
  const isLinux = process.platform === "linux";
  if (!isMac && !isLinux) {
    console.error(`✗ autostart supports macOS (launchd) and Linux (systemd user units); got ${process.platform}.`);
    console.error("  On Windows, create a Task Scheduler job that runs the same `runtimes connect` command.");
    process.exit(1);
  }

  const resolvedKeyFile = path.resolve(
    (keyFlag ?? path.join(os.homedir(), ".config", "tunnel-client", "runtime-key")).replace(/^~/, os.homedir())
  );

  if (action === "install") {
    if (!tunnelId) {
      console.error("✗ --tunnel-id tunnel_... is required for install (it is an identifier, not a secret).");
      process.exit(1);
    }
    if (!fs.existsSync(resolvedKeyFile)) {
      console.error(`✗ Runtime key file not found: ${resolvedKeyFile}`);
      console.error("  Complete the key handoff in docs/chatgpt-setup.md first, or pass --key-file <path>.");
      process.exit(1);
    }
  }

  const bin = resolveCliCommandPath();

  // ---- macOS launchd agent -------------------------------------------------
  if (isMac) {
    const plistDir = path.join(os.homedir(), "Library", "LaunchAgents");
    const label = `us.corpuslaw.consistorium-tunnel.${alias}`;
    const plistPath = path.join(plistDir, `${label}.plist`);

    if (action === "remove") {
      try {
        await fs.promises.unlink(plistPath);
        console.log(`✓ Removed ${plistPath}`);
        console.log(`  Unload now: launchctl bootout gui/$UID/${label} 2>/dev/null || true`);
      } catch {
        console.error(`✗ Not found: ${plistPath}`);
        process.exit(1);
      }
      return;
    }

    const programArguments = ["/bin/zsh", "-lc", buildConnectShell(alias, tunnelId!, resolvedKeyFile, bin)];
    const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const logBase = path.join(os.homedir(), ".cache", "consistorium");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>${path.join(logBase, `${label}.log`)}</string>
  <key>StandardErrorPath</key><string>${path.join(logBase, `${label}.err`)}</string>
</dict>
</plist>
`;
    await fs.promises.mkdir(plistDir, { recursive: true });
    await fs.promises.mkdir(logBase, { recursive: true });
    await fs.promises.writeFile(plistPath, plist, { mode: 0o600 });
    console.log(`✓ Wrote ${plistPath}`);
    console.log(`  Load it now:   launchctl bootstrap gui/$UID ${plistPath}`);
    console.log(`  Check status:  tunnel-client runtimes status ${alias}`);
    console.log(`  Remove later:  consistorium autostart remove --alias ${alias}`);
    return;
  }

  // ---- Linux systemd user unit + timer -------------------------------------
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  const base = `consistorium-tunnel-${alias}`;
  const unitPath = path.join(unitDir, `${base}.service`);
  const timerPath = path.join(unitDir, `${base}.timer`);

  if (action === "remove") {
    let removed = false;
    for (const p of [timerPath, unitPath]) {
      try {
        await fs.promises.unlink(p);
        removed = true;
        console.log(`✓ Removed ${p}`);
      } catch {
        /* already gone */
      }
    }
    if (!removed) {
      console.error(`✗ Nothing to remove under ${unitDir}`);
      process.exit(1);
    }
    console.log("  Run: systemctl --user daemon-reload && systemctl --user disable --now " + base + ".timer 2>/dev/null || true");
    return;
  }

  const execLine = `/bin/sh -lc '${buildConnectShell(alias, tunnelId!, resolvedKeyFile, bin).replace(/'/g, `'\\''`)}'`;
  await fs.promises.mkdir(unitDir, { recursive: true });
  await fs.promises.writeFile(
    unitPath,
    `[Unit]
Description=Consistorium Secure MCP Tunnel runtime (${alias})
After=network-online.target

[Service]
Type=oneshot
ExecStart=${execLine}
`,
    { mode: 0o600 }
  );
  await fs.promises.writeFile(
    timerPath,
    `[Unit]
Description=Periodically ensure the Consistorium tunnel runtime is ready

[Timer]
OnBootSec=90
OnUnitActiveSec=15min

[Install]
WantedBy=timers.target
`,
    { mode: 0o600 }
  );
  console.log(`✓ Wrote ${unitPath}`);
  console.log(`✓ Wrote ${timerPath}`);
  console.log(`  Enable now:   systemctl --user daemon-reload && systemctl --user enable --now ${base}.timer`);
  console.log(`  Check status: tunnel-client runtimes status ${alias}`);
  console.log(`  Remove later: consistorium autostart remove --alias ${alias}`);
}

function resolveCliCommandPath(): string {
  const self = process.argv[1];
  if (self && fs.existsSync(self)) {
    try {
      return fs.realpathSync(path.resolve(self));
    } catch {
      return path.resolve(self);
    }
  }
  return "consistorium";
}

function buildServerEntry(command: string, args: string[], configPath: string): Record<string, unknown> {
  return {
    command,
    args,
    env: { CONSISTORIUM_CONFIG: configPath },
  };
}

async function cmdMcpSnippet(args: string[]): Promise<void> {
  let client: string | undefined;
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--client" || args[i] === "-c") && args[i + 1]) client = args[++i]?.toLowerCase();
    else if (args[i] === "--config" && args[i + 1]) configPath = args[++i];
  }

  if (!client) {
    console.error("Usage: consistorium mcp-snippet --client <name> [--config <path>]");
    console.error("Clients: claude-code, claude-desktop, cursor, windsurf, codex, generic");
    process.exit(1);
  }

  // Resolve the config path exactly like doctor does, so the snippet always matches reality.
  const explicit = configPath ?? process.env.CONSISTORIUM_CONFIG ?? process.env.CONTEXT_BRIDGE_CONFIG;
  let resolvedConfig: string | null = null;
  try {
    const found = explicit ?? findConfigFile();
    if (found) {
      loadConfigSync(found); // prove it exists/parses; snippet should point at a working config
      resolvedConfig = path.resolve(found);
    }
  } catch {
    resolvedConfig = null;
  }
  if (!resolvedConfig) {
    const fallback = getDefaultConfigPath();
    console.error(`✗ No readable configuration found${explicit ? ` at ${explicit}` : ""}.`);
    console.error(`  Run \`consistorium init\` first, or pass --config <path>.`);
    console.error(`  Default location: ${fallback}`);
    process.exit(1);
  }

  const bin = resolveCliCommandPath();

  switch (client) {
    case "claude-code": {
      const entry = buildServerEntry(bin, ["serve"], resolvedConfig);
      console.log(
        `claude mcp add-json consistorium '${JSON.stringify(entry)}'`
      );
      break;
    }
    case "claude-desktop":
    case "cursor":
    case "windsurf": {
      const scope =
        client === "claude-desktop"
          ? "Claude Desktop → Settings → Developer → Edit Config (claude_desktop_config.json)"
          : client === "cursor"
            ? "~/.cursor/mcp.json (or Project Settings → MCP → Add)"
            : "~/.codeium/windsurf/mcp_config.json";
      console.log(`// ${scope}`);
      console.log(JSON.stringify({ mcpServers: { consistorium: buildServerEntry(bin, ["serve"], resolvedConfig) } }, null, 2));
      break;
    }
    case "codex": {
      console.log("# Add to ~/.codex/config.toml under [mcp_servers.consistorium]");
      console.log("[mcp_servers.consistorium]");
      console.log(`command = "${bin}"`);
      console.log("args = [\"serve\"]");
      console.log("");
      console.log("[mcp_servers.consistorium.env]");
      console.log(`CONSISTORIUM_CONFIG = "${resolvedConfig}"`);
      break;
    }
    case "generic":
      console.log(JSON.stringify(buildServerEntry(bin, ["serve"], resolvedConfig), null, 2));
      break;
    default:
      console.error(`Unknown client: ${client}`);
      console.error("Clients: claude-code, claude-desktop, cursor, windsurf, codex, generic");
      process.exit(1);
  }
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

function readRepeatFlag(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) values.push(args[++i]!);
  }
  return values;
}

async function cmdServe(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const http = args.includes("--http");
  if (!http) {
    const { startStdioServer } = await import("../mcp/server.js");
    await startStdioServer({ allowWrites: !args.includes("--read-only") });
    return;
  }

  const host =
    readFlag(args, "--host") ??
    process.env.CONSISTORIUM_HTTP_HOST ??
    process.env.CONTEXT_BRIDGE_HTTP_HOST ??
    "127.0.0.1";
  const portRaw =
    readFlag(args, "--port") ??
    process.env.CONSISTORIUM_HTTP_PORT ??
    process.env.CONTEXT_BRIDGE_HTTP_PORT ??
    "8787";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid --port: ${portRaw}`);
    process.exit(1);
  }
  const token = readFlag(args, "--token");
  const allowAnonymous = args.includes("--allow-anonymous");
  const allowWrites = args.includes("--allow-writes");
  const allowedHosts = readRepeatFlag(args, "--allowed-host");

  try {
    validateHttpOptions({ host, token, allowAnonymous });
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }

  const started = await startHttpServer({
    host,
    port,
    token,
    allowAnonymous,
    allowWrites,
    allowedHosts,
  });
  console.error(`Listening at ${started.url}`);
  console.error(`Health: ${started.url.replace(/\/mcp$/, "/healthz")}`);
  if (started.token) console.error("Authorization: Bearer <token>");
  if (!started.allowWrites) console.error("HTTP writes are disabled. Execution agents should use stdio.");
}

async function cmdDoctor(args: string[]): Promise<void> {
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--config" || args[i] === "-c") && args[i + 1]) configPath = args[++i];
  }
  const explicit =
    configPath ??
    process.env.CONSISTORIUM_CONFIG ??
    process.env.CONTEXT_BRIDGE_CONFIG;
  const found = explicit ?? findConfigFile();
  if (!found) {
    console.error("✗ No configuration found. Run: consistorium init --path <repo> --yes");
    console.error(`  Searched: ${getDefaultConfigPaths().join(", ")}`);
    process.exit(1);
  }

  const { raw, filePath } = loadConfigSync(found);
  const resolved = resolveConfigSync(raw, filePath);
  const stateDir = resolveStateDir(resolved.configPath, resolved.projects);
  console.log(`✓ Config: ${filePath}`);
  console.log(`  Projects: ${resolved.projects.map((p) => `${p.name} → ${p.canonicalPath}`).join("; ") || "(none)"}`);
  console.log(`  State dir: ${stateDir}`);
  console.log(`  Context globs: ${resolved.projects.map((p) => `${p.name}[${p.contextPatterns.join(", ")}]`).join("; ")}`);
  console.log(`  Stdio: consistorium serve`);
  console.log(`  HTTP:  consistorium serve --http --port 8787`);

  const runtime = bootstrap({ allowWrites: false, configPath: filePath });
  if (runtime.noConfig || runtime.config.projects.length === 0) {
    console.log("  Smoke: skipped (no projects)");
    return;
  }
  for (const project of runtime.config.projects) {
    try {
      const briefing = await buildProjectBriefing(runtime.service, runtime.continuity, project.name);
      console.log(`✓ Smoke briefing for ${project.name}`);
      console.log(`  Live: ${briefing.live.branch ?? "(no branch)"} @ ${briefing.live.headShort ?? "n/a"} dirty=${briefing.live.isDirty}`);
      console.log(`  Open tasks: ${briefing.continuity.openTasks.length}`);
      console.log(`  Handoffs: ${briefing.continuity.latestHandoffs.length}`);
      console.log(`  Recommended: ${briefing.recommendedFocus.rationale}`);
    } catch (e) {
      console.error(`✗ Smoke briefing failed for ${project.name}: ${(e as Error).message}`);
      process.exit(1);
    }
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
    await cmdServe(rest);
    return;
  }
  if (cmd === "doctor") {
    await cmdDoctor(rest);
    return;
  }
  if (cmd === "mcp-snippet") {
    await cmdMcpSnippet(rest);
    return;
  }
  if (cmd === "autostart") {
    await cmdAutostart(rest);
    return;
  }
  if (cmd === "token") {
    console.log(generateToken());
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
