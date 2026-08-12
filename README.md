# Context Bridge — Portable Agent-to-Agent Continuity

> A vendor-neutral, local-first continuity layer for structured tasks, handoffs, and bounded live development-state observation.

Modern developers run multiple AI coding agents, models, sessions, branches, and git worktrees simultaneously. Each agent understands its own task, but **no single intelligence sees the whole live state**. The human becomes the synchronization layer.

Context Bridge answers two related questions:

> *“What is actually happening right now, and where did the previous agent leave the task?”*

Repository inspection is read-only. The only durable writes are bounded structured task/handoff records in a local state directory outside configured project roots by default. Context Bridge does not control agents, execute commands on their behalf, or use a network service.

---

## What it is / what it is not

| It **is** | It **is not** |
|---|---|
| Structured task and handoff continuity | A coding agent or execution service |
| Bounded read-only repository observation | A multi-agent orchestrator |
| MCP server + Agent Plugin | A dashboard / SaaS / Kanban board |
| Local-first state, no cloud, no telemetry | An embedding / vector-search product |

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
│  17 context.* tools · strict JSON · bounded outputs      │
└───────────────────────┬─────────────────────────────────┘
                        │ delegates to
┌───────────────────────▼─────────────────────────────────┐
│  ContextService + ContinuityStore (src/core)              │
│  Observation + local task/handoff records; no execution   │
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
           └───────────────┬──────────────────┘
                           ▼
                ┌──────────────────────┐
                │ Local state directory │
                │ tasks/ + handoffs/   │
                │ atomic, mode 0700/600│
                └──────────────────────┘
                           │
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

When installed as an Agent Plugin, `mcp.json` is discovered at the plugin root and launches `node` with `./dist/mcp/server.js` as an argument and `cwd: ${PLUGIN_ROOT}`. This avoids relying on executable mode bits and keeps command/argument behavior portable across MCP hosts. Set `CONTEXT_BRIDGE_STATE_DIR` if you need to choose the state location explicitly; otherwise the server chooses an unprivileged XDG/home/temp location outside configured project roots.

The same standard STDIO configuration can be used by Claude Code, Cursor, Codex, or another MCP host, including hosts that import an existing MCP entry. The core server has no host-specific behavior, authentication, headers, or network dependency. It emits MCP protocol data on stdout only; startup diagnostics and fatal errors go to stderr. Hosts should set an explicit config path and, when using relative `args`, a predictable `cwd`.

### Connect Hermes

After building, add the stdio server to Hermes with portable paths. The exact flag values below are ordinary Hermes CLI options; replace the placeholders for your machine:

```bash
hermes mcp add context-bridge \
  --command node \
  --args /portable/path/context-bridge/dist/mcp/server.js \
  --env CONTEXT_BRIDGE_CONFIG=/portable/path/context-bridge-config.yaml \
  --env CONTEXT_BRIDGE_STATE_DIR=/portable/path/context-bridge-state
```

The two `--env KEY=VALUE` entries are passed to the stdio server as environment variables.

The config must explicitly list the repository root. The state directory may be outside the repository; do not put it in a project unless you intentionally set `CONTEXT_BRIDGE_STATE_DIR` there.

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

# 4. Establish a task, then leave a structured handoff
#    The agent calls context.task_upsert and context.handoff_create.
#    A fresh agent calls context.task_list, context.task_get,
#    context.handoff_list, and context.handoff_get before direct verification.
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

Configured project names are portable safe identifiers: 1–128 letters, numbers, `.`, `_`, or `-`, beginning with a letter or number (for example, `my-project`). Spaces and other punctuation are rejected when the config is parsed because the same name is used by continuity tools.

Task creation is simple: omit `expectedUpdatedAt` for a new task. To update an existing task, pass the `updatedAt` returned by `context.task_get` or the previous `context.task_upsert` response as `expectedUpdatedAt`; stale or missing versions return a structured `CONFLICT` and preserve the record. Explicit duplicate `handoffId` values likewise return `CONFLICT` and never overwrite the first record. These write controls serialize records within one stdio server process. Cross-process coordination remains a documented P2.

Only allowlisted `projects[].path` are ever inspected. Only `context` globs are readable as documents. Everything else is denied.

---

## MCP tools (17)

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
| `context.task_upsert` | Create or update a bounded durable task |
| `context.task_list` | List compact task summaries |
| `context.task_get` | Read task detail plus refreshed live repository availability |
| `context.handoff_create` | Create a handoff with canonical observed Git state |
| `context.handoff_list` | List compact handoff summaries |
| `context.handoff_get` | Read handoff detail, refresh state, and show staleness/mismatches |

Lists are intentionally compact; detail is retrieved only with `*_get`. Handoff repository facts are split into canonical observations and optional agent assertions. Assertions never replace live canonical values. Large outputs are bounded, not dumped.

Design principle: `context.project_snapshot` should answer ~80% of *"what's going on?"* without chaining 20 calls.

---

## Agent Skill: `project-state`

The skill at `skills/project-state/SKILL.md` teaches a consuming model to:

1. Discover the project, then list tasks and compact handoffs
2. Get the selected task and latest handoff before asking for detail
3. Verify canonical branch/HEAD/worktree state directly after orientation
4. Surface parallel worktrees (don't assume `main` is reality)
5. Respect allowlisting, availability, staleness, and assertion mismatches
6. Distinguish observed facts from inference

See the skill file for the full workflow.

---

## Security model

Read `THREAT_MODEL.md` and `SECURITY.md` for details. Summary invariants:

- **Explicit allowlist** — only `projects[].path` are inspected; path is canonicalized via `realpath` and checked via `SecurityPolicy`.
- **No `..` traversal, no symlink escapes** — missing-tail realpath, segment checks, and `isInsideAllowedRoot`.
- **No arbitrary filesystem** — no tool exposes raw `readFile("/etc/passwd")`-style access; documents are glob-allowlisted per project. Task/handoff persistence exposes only structured operations, never a generic file-write tool.
- **Denylist for secrets** — `.env`, `*.pem`, `*.key`, `.ssh/`, `.aws/`, `.gnupg/`, `*secret*`, `*token*`, `*credential*`, credential files are denied by default.
- **Binary skip** — known binary extensions and detected binaries are excluded from search/docs/sessions.
- **Bounded outputs and state** — `maxFileSizeBytes` (256 KiB), `maxDiffBytes` (128 KiB), `maxSearchResults` (100), 50-item structured arrays, and 256 KiB records by default.
- **No shell** — git is invoked via `execFile` with allowlisted subcommands (`rev-parse`, `status`, `log`, `diff`, `worktree`, `merge-base`, `rev-list`, etc.) and arg arrays. No string interpolation.
- **Read-only git** — `checkout`, `reset --hard`, `commit`, `push`, `merge`, `rebase`, branch create/delete are never invoked.
- **No network** in the MVP core.
- **State writes** are atomic and mode-restricted (`0700` directories, `0600` records), derived from `CONTEXT_BRIDGE_STATE_DIR` or the config directory, and kept outside inspected repos unless the state-dir variable explicitly opts in.
- **Session preview redaction** — best-effort regex redaction of keys/tokens in session artifacts.

---

## Configuration

Resolution order when no `--config` / `CONTEXT_BRIDGE_CONFIG` is given:

1. `$CONTEXT_BRIDGE_CONFIG` when set, then `$PLUGIN_DATA/config.yaml` / `.json`
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
npm run lint         # ESLint 9 flat config
```

Tests use **synthetic temporary repos** (created in `os.tmpdir()` per test) — they never touch the host filesystem beyond allowed fixtures, and never depend on a private Corpus repo.

---

## Roadmap

See `ROADMAP.md` for deferred items. Near-term:

- Streamable HTTP transport (core is already transport-agnostic)
- More passive agent adapters (Codex, Claude Code) where reliably derivable
- Optional `session-to-content` skill (analyze session artifacts for shareable lessons — with aggressive redaction, no auto-publish)

Outsourcerer is a future adapter/integration item, not a shipped execution path. Not on the roadmap: agent launcher, terminal control plane, worktree creator, or orchestrator — Connect Bridge remains a continuity/state layer with read-only repository observation.

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
