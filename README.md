# Context Bridge — Portable Development Intelligence for AI Agents

> A passive, vendor-neutral, local-first, **read-only** development-context plane that any MCP-capable AI can query.

Modern developers run multiple AI coding agents, models, sessions, branches, and git worktrees simultaneously. Each agent understands its own task, but **no single intelligence sees the whole live state**. The human becomes the synchronization layer.

Context Bridge answers:

> *“What is actually happening in my development environment right now?”*

It exposes that view safely to Codex, ChatGPT, Claude, Cursor, or any MCP-capable agent — without controlling the agents, mutating repos, or leaving the machine.

---

## What it is / what it is not

| It **is** | It **is not** |
|---|---|
| Read-only observability for local dev state | A coding agent |
| MCP server + Agent Plugin | A multi-agent orchestrator |
| Vendor-neutral adapter layer | A dashboard / SaaS / Kanban board |
| Local-first, no cloud, no telemetry | An embedding / vector-search product |

Think: **OpenTelemetry-like observability for agentic development**, exposed through MCP.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  MCP Client (Codex / Claude / Cursor / ChatGPT / ...)   │
└───────────────────────┬─────────────────────────────────┘
                        │ MCP (stdio — primary)
┌───────────────────────▼─────────────────────────────────┐
│  Context Bridge MCP Server  (src/mcp)                    │
│  11 tools  ·  structured JSON  ·  bounded outputs        │
└───────────────────────┬─────────────────────────────────┘
                        │ delegates to
┌───────────────────────▼─────────────────────────────────┐
│  ContextService  (src/core/context.ts)                   │
│  Orchestrates providers. Stable core, transport-agnostic │
│  (ready for future Streamable HTTP without rewrite)      │
└──────────┬──────────┬───────────┬───────────┬───────────┘
           │          │           │           │
     ┌─────▼────┐ ┌───▼────┐ ┌────▼────┐ ┌────▼─────────┐
     │   Git    │ │  Docs  │ │ Search  │ │  Sessions    │
     │ Provider │ │ Provider│ │ Provider│ │  Adapters    │
     │(allow-   │ │(allow-  │ │(bounded)│ │ (generic +  │
     │ listed   │ │ listed  │ │         │ │  interface)  │
     │ git cmd) │ │  globs) │ │         │ │              │
     └──────────┘ └────────┘ └─────────┘ └──────────────┘
           │          │           │           │
┌──────────▼──────────▼───────────▼───────────▼───────────┐
│  Security / Policy  (src/core/security.ts)               │
│  • workspace allowlisting  • realpath canonicalization   │
│  • symlink escape prevention  • secret-file denylist     │
│  • binary skip  • size caps  • no shell interpolation  │
└──────────────────────────────────────────────────────────┘
           │
┌──────────▼──────────┐
│  Config  (YAML/JSON)│  ← explicit allowlist only
│  ~/.config/context-bridge/config.yaml  or $PLUGIN_DATA │
└─────────────────────┘
```

Why this layering? The `ContextService` is the portable core. Transport (today stdio, tomorrow Streamable HTTP) is a thin wrapper. Adding a new agent adapter touches only `src/adapters/`.

---

## Installation

### As an Agent Plugin (recommended)

Context Bridge ships as an **Agent Plugins v1.0** plugin:

- `plugin.json` at the root
- MCP servers in `mcp.json` (stdio — primary)
- skill at `skills/project-state/SKILL.md`

Install it by pointing your MCP client at the plugin directory or by installing via your client's plugin manager (see your client's docs for `plugin.json` / `mcp.json` handling).

### From source

```bash
git clone https://github.com/context-bridge/context-bridge
cd context-bridge
npm install --cache /tmp/npm-cache  # or just npm install
npm run build

# init config
node dist/cli/index.js init
# or: npx context-bridge init

# validate
node dist/cli/index.js config validate
```

### MCP client configuration

Most clients accept an `mcp.json` like:

```json
{
  "mcpServers": {
    "context-bridge": {
      "command": "node",
      "args": ["/path/to/context-bridge/dist/mcp/server.js"],
      "env": {
        "CONTEXT_BRIDGE_CONFIG": "/home/you/.config/context-bridge/config.yaml"
      }
    }
  }
}
```

When installed as an Agent Plugin, `mcp.json` is discovered at the plugin root and the server is launched via `command: ./dist/mcp/server.js` with `cwd: ${PLUGIN_ROOT}`.

---

## Quick start

```bash
# 1. Initialize — you explicitly allowlist project roots
context-bridge init
# interactive: enter /Users/you/dev/my-project and name it

# flag-driven:
context-bridge init --path ~/dev/my-project --context "TODO.md" --context "docs/**/*.md" --yes

# 2. Check it
context-bridge config show
context-bridge config validate

# 3. Ask your agent (with Context Bridge connected):
#   "Give me a project snapshot for my-project"
#   "What worktrees currently exist?"
#   "Which worktrees have uncommitted changes?"
#   "What does TODO.md say?"
```

Example config (`~/.config/context-bridge/config.yaml`):

```yaml
version: 1
projects:
  - name: my-project
    path: /Users/me/dev/my-project
    context:
      - TODO.md
      - ROADMAP.md
      - docs/**/*.md
      - reports/**/*.md
sessionArtifacts:
  patterns:
    - reports/**/*.md
    - sessions/**/*.json
```

Only allowlisted `projects[].path` are ever inspected. Only `context` globs are readable as documents. Everything else is denied.

---

## MCP tools (11)

| Tool | What it answers |
|---|---|
| `context.list_projects` | Which projects are configured? |
| `context.project_snapshot` | **Hero tool** — branch, HEAD, dirty, worktrees, recent commits, docs, sessions in one call |
| `context.list_worktrees` | What worktrees exist and which are dirty? |
| `context.worktree_snapshot` | Snapshot of a specific worktree by path |
| `context.recent_changes` | Recent commits, changed files, diff stat |
| `context.compare` | Compare two refs (merge-base, ahead/behind, commits, bounded diff) |
| `context.search` | Bounded text search → file/line/preview |
| `context.list_context_documents` | Which docs are allowlisted & discovered? |
| `context.read_context_document` | Read one allowlisted doc (bounded, policy-checked) |
| `context.list_agent_sessions` | Which agent/session artifacts were found? |
| `context.session_snapshot` | Detail + redacted preview of one session |

All tools return structured JSON with `provenance.observedAt`. Large outputs are truncated, not dumped.

Design principle: `context.project_snapshot` should answer ~80% of *"what's going on?"* without chaining 20 calls.

---

## Agent Skill: `project-state`

The skill at `skills/project-state/SKILL.md` teaches a consuming model to:

1. Call `list_projects` → `project_snapshot` before strategic advice
2. Surface parallel worktrees (don't assume `main` is reality)
3. Prefer summaries/diff-stat before requesting bounded diffs
4. Respect allowlisting and staleness (`observedAt`)
5. Distinguish observed facts from inference

See the skill file for the full workflow.

---

## Security model

Read `THREAT_MODEL.md` and `SECURITY.md` for details. Summary invariants:

- **Explicit allowlist** — only `projects[].path` are inspected; path is canonicalized via `realpath` and checked via `SecurityPolicy`.
- **No `..` traversal, no symlink escapes** — missing-tail realpath, segment checks, and `isInsideAllowedRoot`.
- **No arbitrary filesystem** — no tool exposes raw `readFile("/etc/passwd")`-style access; documents are glob-allowlisted per project.
- **Denylist for secrets** — `.env`, `*.pem`, `*.key`, `.ssh/`, `.aws/`, `.gnupg/`, `*secret*`, `*token*`, `*credential*`, credential files are denied by default.
- **Binary skip** — known binary extensions and detected binaries are excluded from search/docs/sessions.
- **Bounded outputs** — `maxFileSizeBytes` (256 KiB), `maxDiffBytes` (128 KiB), `maxSearchResults` (100) by default; every tool respects caps and signals `truncated`.
- **No shell** — git is invoked via `execFile` with allowlisted subcommands (`rev-parse`, `status`, `log`, `diff`, `worktree`, `merge-base`, `rev-list`, etc.) and arg arrays. No string interpolation.
- **Read-only git** — `checkout`, `reset --hard`, `commit`, `push`, `merge`, `rebase`, branch create/delete are never invoked.
- **No network** in the MVP core.
- **Config/data writes** only to `PLUGIN_DATA` or the user's config directory, never into inspected repos unless `context-bridge init --output` explicitly targets there.
- **Session preview redaction** — best-effort regex redaction of keys/tokens in session artifacts.

---

## Configuration

Resolution order when no `--config` / `CONTEXT_BRIDGE_CONFIG` is given:

1. `$PLUGIN_DATA/config.yaml` / `.json`
2. `$XDG_CONFIG_HOME/context-bridge/config.yaml` (or `~/.config/context-bridge/config.yaml`)
3. `./.context-bridge.yaml`, `./context-bridge.yaml`, `.json` variants in `cwd`

`context-bridge init` writes YAML by default. Both YAML and JSON are accepted on load.

See `example-config.yaml` for a full annotated example.

---

## Development

```bash
npm run build        # tsc
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run lint         # eslint (if configured)
```

Tests use **synthetic temporary repos** (created in `os.tmpdir()` per test) — they never touch the host filesystem beyond allowed fixtures, and never depend on a private Corpus repo.

---

## Roadmap

See `ROADMAP.md` for deferred items. Near-term:

- Streamable HTTP transport (core is already transport-agnostic)
- More passive agent adapters (Codex, Claude Code) where reliably derivable
- Optional `session-to-content` skill (analyze session artifacts for shareable lessons — with aggressive redaction, no auto-publish)

Not on the roadmap: agent launcher, terminal control plane, worktree creator, orchestrator — Context Bridge stays observability-only.

---

## Contributing

See `CONTRIBUTING.md`.

## Security

See `SECURITY.md` to report vulnerabilities.

## License

Apache-2.0 — see `LICENSE`.

## Agent Plugins conformance

- `plugin.json` validates against `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`
- `mcp.json` validates against `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`
- Skills discovered at `skills/*/SKILL.md`
- MCP stdio is primary; Streamable HTTP is architected for later
- `PLUGIN_ROOT` / `PLUGIN_DATA` placeholders are handled per spec

Spec discrepancy notes (if any) are documented in `DESIGN.md`.
