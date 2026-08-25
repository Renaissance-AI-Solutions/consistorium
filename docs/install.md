# Installing Consistorium

Complete installation and setup guide. For the short version, see the README quickstart.

## Prerequisites

| Requirement | Check | Notes |
|---|---|---|
| Node.js **20 or newer** | `node --version` | v20 LTS or later; Consistorium uses WebCrypto globals absent in older Node |
| npm | `npm --version` | Ships with Node |
| git | `git --version` | On `PATH`; used read-only |
| A repository to connect | — | You explicitly allowlist every directory Consistorium can inspect |

Works on macOS, Linux, and Windows (PowerShell). No other runtime, database, or service required.

## 1. Install

```bash
npm install -g consistorium
```

If that returns `E404`, the first npm registry release has not been published yet. Install from
source instead:

```bash
git clone https://github.com/Renaissance-AI-Solutions/consistorium.git
cd consistorium
npm install
npm run build
npm install -g .
```

`npm install` by itself only installs this project's dependencies; it does not install the global
`consistorium` command. The explicit build keeps the source fallback compatible with npm versions
that restrict package lifecycle scripts.

Verify:

```bash
consistorium version
consistorium --help
```

Once the registry package is available, every command below also works prefixed with `npx`:

```bash
npx consistorium init --path ~/dev/my-project --yes
```

<details>
<summary>Install from source (contributors)</summary>

```bash
git clone https://github.com/Renaissance-AI-Solutions/consistorium
cd consistorium
npm install
npm run build
node dist/cli/index.js --help
```

</details>

## 2. Allowlist your project(s)

Consistorium can only ever inspect directories you explicitly allowlist. Nothing else on your machine is reachable.

```bash
# Single project, non-interactive (recommended)
consistorium init --path ~/dev/my-project --name my-project --yes

# Multiple projects
consistorium init \
  --path ~/dev/my-project --name my-project \
  --path ~/dev/other-repo --name other-repo \
  --yes

# Custom document globs (what an MCP client may read as documents)
consistorium init --path ~/dev/my-project --yes \
  --context README.md \
  --context DESIGN.md \
  --context TODO.md \
  --context "docs/**/*.md"
```

What this writes: `~/.config/context-bridge/config.yaml` (override location with `--output` or the `CONTEXT_BRIDGE_CONFIG` environment variable).

Defaults if you omit `--context`: `README.md`, `DESIGN.md`, `TODO.md`, `ROADMAP.md`, `docs/**/*.md`. Globs are root-relative; secret-looking files (`.env`, keys, credentials) are always denied even if a glob would match them. See `example-config.yaml` in the repository for a fully commented configuration, including optional session-artifact patterns.

To re-run safely against an existing config, add `--force`.

## 3. Verify

```bash
consistorium doctor
```

Doctor checks your config, state directory, and runs a live smoke briefing against each allowlisted project. Fix anything it reports before connecting a client.

## 4. Connect your MCP client

All stdio-based clients use the same shape: run command `consistorium` with argument `serve`, plus the `CONTEXT_BRIDGE_CONFIG` environment variable pointing at your config.

### Claude Desktop

Edit `claude_desktop_config.json` (**Settings → Developer → Edit Config**; macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "consistorium": {
      "command": "consistorium",
      "args": ["serve"],
      "env": { "CONTEXT_BRIDGE_CONFIG": "~/.config/context-bridge/config.yaml" }
    }
  }
}
```

Restart Claude Desktop afterward.

### Claude Code

```bash
claude mcp add consistorium \
  --env CONTEXT_BRIDGE_CONFIG="$HOME/.config/context-bridge/config.yaml" \
  -- consistorium serve
```

(Or edit `~/.claude.json` with the JSON shape above.)

### Cursor

Edit `~/.cursor/mcp.json` (or **Cursor Settings → MCP**) with the same JSON shape as Claude Desktop. Restart Cursor.

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json` with the same JSON shape. Reload Windsurf.

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.consistorium]
command = "consistorium"
args = ["serve"]
env = { "CONTEXT_BRIDGE_CONFIG" = "~/.config/context-bridge/config.yaml" }
```

(Exact key names can vary by Codex version — see `codex --help` / OpenAI docs if your build differs.)

### Hermes

```bash
hermes mcp add consistorium \
  --command consistorium \
  --args serve \
  --env CONTEXT_BRIDGE_CONFIG="$HOME/.config/context-bridge/config.yaml"
```

### Anything else (generic stdio MCP)

| Field | Value |
|---|---|
| Command | `consistorium` |
| Args | `serve` |
| Env | `CONTEXT_BRIDGE_CONFIG=/path/to/config.yaml` |

If your client cannot expand `~`, use an absolute path (macOS/Linux: `/Users/you/.config/context-bridge/config.yaml`; Windows: `%USERPROFILE%\.config\context-bridge\config.yaml`).

### ChatGPT

ChatGPT connects via OpenAI's Secure MCP Tunnel. The recommended tunnel profile launches this
stdio server itself, so only one long-lived runtime is needed — see
**[chatgpt-setup.md](chatgpt-setup.md)** for the complete walkthrough.

## 5. First useful command

In any connected client, ask:

> What changed in my-project recently, and what should be done next?

The model should call `context_list_projects`, then `context_project_briefing`. A grounded answer cites live branch state and documents, labeled `live_observation` vs `agent_record`.

**For coding-agent continuity**, teach each of your execution agents this loop:

1. Starting work → call `context_task_upsert` (objective, constraints, next actions)
2. Leaving work → call `context_handoff_create` (summary, findings, blockers, next action)
3. Fresh session → call `context_project_briefing` before doing anything else

## One-prompt setup for AI agents

Use the maintained handoffs in **[agent-install.md](agent-install.md)**. They cover:

- local clients such as Claude Code, Codex, Cursor, Windsurf, and Hermes;
- ChatGPT through a private, read-only OpenAI Secure MCP Tunnel runtime; and
- repair when Corpus Connect is visible in ChatGPT but its tools are not callable.

The local-client micro-prompt is:

```text
Open https://github.com/Renaissance-AI-Solutions/consistorium/blob/main/docs/agent-install.md and
execute Prompt A for the repository we are currently working in. Preserve existing configuration
and prove the result with real context_list_projects and context_project_briefing calls.
```

## Configuration reference

| Env var | Purpose |
|---|---|
| `CONTEXT_BRIDGE_CONFIG` | Explicit config file path |
| `CONTEXT_BRIDGE_STATE_DIR` | Task/handoff state directory (defaults outside all project roots) |
| `CONTEXT_BRIDGE_TOKEN` | Bearer token for HTTP transport |
| `CONTEXT_BRIDGE_HTTP_WRITES=1` | Enable write tools on HTTP transport (off by default) |
| `CONTEXT_BRIDGE_HTTP_HOST` / `_PORT` | HTTP bind defaults (127.0.0.1 / 8787) |

CLI commands: `init`, `config show`, `config validate`, `serve [--read-only] [--http]`, `doctor`,
`token`, `version`, `help`.

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| npm returns `E404` for `consistorium` | The registry release is not live; use the source-install fallback in step 1 |
| `consistorium: command not found` | npm global bin dir isn't on `PATH`. Run `npm config get prefix`, add `<prefix>/bin` (macOS/Linux), or use the absolute binary path |
| `EACCES` during global install | Do not use `sudo`. Either use `npx`, or move your npm prefix (`npm config set prefix ~/.npm-global`) and add it to `PATH` |
| Tools appear but say *no configuration* | Client didn't receive `CONTEXT_BRIDGE_CONFIG`; check the `env` block, then `consistorium config show` |
| `Project not found: X` | Tool argument must equal a `projects[].name` in the config exactly |
| `Document not allowlisted` | Path doesn't match that project's `context` globs — widen deliberately with `--context`, or edit the config |
| Briefing shows empty purpose/architecture | No matching documents discovered; check filenames/globs and that files aren't denylisted (secrets, binaries) |
| Node version error / `crypto is not defined` | You're on Node < 20; upgrade Node |
| Windows path issues | Use absolute paths in configs; `$HOME` → `$env:USERPROFILE` in PowerShell |
| Corpus Connect is visible but has no callable tools | Keep the managed runtime ready, open **Settings → Plugins → Corpus Connect → Refresh**, then attach it explicitly in a new chat; follow [chatgpt-setup.md](chatgpt-setup.md) |

Still stuck? [Open an issue](https://github.com/Renaissance-AI-Solutions/consistorium/issues).

## Uninstall / upgrade

```bash
npm uninstall -g consistorium     # removes the server; config and records remain
rm -rf ~/.config/context-bridge   # remove config (and its state/, if you kept them together)
npm install -g consistorium       # upgrade = reinstall latest
```

Your task/handoff records live outside your repositories and survive reinstalls.
