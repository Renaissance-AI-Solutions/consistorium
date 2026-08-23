# Consistorium

> Local-first strategic context and agent-to-agent continuity for your repositories.

**Consistorium** is the product. **Context Bridge** is the MCP server that implements it, and is
the name behind every identifier you will actually type: the `context-bridge` package and CLI,
the `~/.config/context-bridge/` config directory, the `CONTEXT_BRIDGE_*` environment variables,
and the `context_*` MCP tools. Both names appear throughout these docs. They are one project.

Context Bridge sits between:

- repositories and execution agents (Codex, Claude Code, Hermes, Grok, …)
- high-level reasoning agents (especially ChatGPT)

Execution agents work in the repo and record structured tasks/handoffs.
Context Bridge reconstructs the useful current state.
ChatGPT (or any MCP client) can ask “What should we do next with Corpus?” and retrieve grounded context instead of a pasted history.

Repository inspection is read-only. The only durable writes are bounded task/handoff records in a local state directory outside configured project roots by default.

---

## What it is / what it is not

| It **is** | It **is not** |
|---|---|
| Strategic context + task/handoff continuity | A coding agent or execution service |
| Bounded read-only repository observation | A multi-agent orchestrator |
| MCP over **stdio** and **Streamable HTTP** | A SaaS product or dashboard |
| Local-first state, no telemetry | An embedding / vector-search product |

---

## Architecture

```
Execution agents (stdio MCP)
        │
        ▼
┌─────────────────────────────────────────────┐
│  Context Bridge core                         │
│  ContextService + ContinuityStore + briefing │
└───────────────┬─────────────────────────────┘
                │
     ┌──────────┴──────────┐
     │                     │
 stdio MCP            Streamable HTTP /mcp
 (Hermes, Claude,     (ChatGPT Developer Mode,
  Codex, Cursor)       Inspector, Responses API)
```

`src/mcp/app.ts` is the portable core. Transports are thin wrappers.

---

## Prerequisites

- Node.js 18+
- `git` on `PATH`
- A local repository you explicitly allowlist

---

## Install and start

```bash
# TODO(release): replace with the published repository URL
git clone https://github.com/context-bridge/context-bridge.git
cd context-bridge
npm install
npm run build
node dist/cli/index.js init --path /Users/you/dev/Corpus --name corpus --yes
node dist/cli/index.js doctor
npm test
```

`init` writes `~/.config/context-bridge/config.yaml` (or `$PLUGIN_DATA/config.yaml`) and allowlists only the paths you pass.

Useful commands:

```bash
node dist/cli/index.js config show
node dist/cli/index.js config validate
node dist/cli/index.js doctor
node dist/cli/index.js token
node dist/cli/index.js serve              # stdio MCP
node dist/cli/index.js serve --http       # Streamable HTTP on 127.0.0.1:8787/mcp
```

---

## Add a project

```bash
node dist/cli/index.js init \
  --path ~/dev/Corpus \
  --name corpus \
  --context README.md \
  --context DESIGN.md \
  --context TODO.md \
  --context "docs/**/*.md" \
  --yes --force
```

Project names must be safe identifiers: `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.

Only `projects[].path` is inspected. Only `context` globs are readable as documents.

---

## Connect an execution agent (stdio)

Most local agents launch a process. Point them at the built stdio server:

```json
{
  "mcpServers": {
    "context-bridge": {
      "command": "node",
      "args": ["/absolute/path/Context-Bridge/dist/mcp/server.js"],
      "env": {
        "CONTEXT_BRIDGE_CONFIG": "/Users/you/.config/context-bridge/config.yaml"
      }
    }
  }
}
```

As an Agent Plugin, `mcp.json` launches `node ./dist/mcp/server.js` with `cwd: ${PLUGIN_ROOT}`.

Hermes:

```bash
hermes mcp add context-bridge \
  --command node \
  --args /absolute/path/Context-Bridge/dist/mcp/server.js \
  --env CONTEXT_BRIDGE_CONFIG=/Users/you/.config/context-bridge/config.yaml \
  --env CONTEXT_BRIDGE_STATE_DIR=/Users/you/.local/state/context-bridge
```

The agent should:

1. `context_task_upsert` when work starts
2. `context_handoff_create` when it leaves
3. A fresh agent should call `context_project_briefing` (or task/handoff list+get) before continuing

---

## Connect ChatGPT

ChatGPT does not launch a local stdio process — it reaches an MCP server over the network, and
supports **OAuth or no authentication only**. There is no API-key field, so the bearer token this
server uses on HTTP cannot be supplied by ChatGPT. The supported private path is OpenAI's
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), which makes
the tunnel the access boundary instead of the public internet.

### 1. Start the local HTTP server

```bash
export CONTEXT_BRIDGE_CONFIG="$HOME/.config/context-bridge/config.yaml"
node dist/cli/index.js serve --http --port 8787 --allow-anonymous
```

```
[context-bridge] Streamable HTTP on http://127.0.0.1:8787/mcp (bind=127.0.0.1 writes=off auth=anonymous-loopback)
```

`--allow-anonymous` is accepted only on a loopback bind; a non-loopback bind refuses to start
without a token. HTTP write tools stay disabled unless you pass `--allow-writes` — execution
agents should record tasks and handoffs over stdio instead. Verify before going further:

```bash
curl -sS http://127.0.0.1:8787/healthz
```

### 2. Create the tunnel and a runtime key

1. Create a tunnel in [Tunnels management](https://platform.openai.com/settings/organization/tunnels)
   and copy its `tunnel_...` ID.
2. Create a **runtime** key in [API keys](https://platform.openai.com/settings/organization/api-keys)
   with **Restricted** permissions and the **Tunnels: Read + Use** scope. `Read only` is not
   enough — the daemon needs `Use`. `Manage` is only for creating and deleting tunnels, and an
   admin key should never be given to a long-lived daemon.
3. Download [`tunnel-client`](https://github.com/openai/tunnel-client/releases/latest) for your
   platform and check it against the release's `SHA256SUMS.txt` before running it.

### 3. Point the tunnel at this server

```bash
tunnel-client init --sample sample_mcp_remote_no_auth --profile context-bridge --tunnel-id tunnel_YOUR_ID --mcp-server-url http://127.0.0.1:8787/mcp
```

`sample_mcp_remote_no_auth` is the right sample: this server is reachable over HTTP and
intentionally advertises no OAuth/PRMD metadata, and that sample expects protected-resource
metadata to 404. The generated profile records `api_key: "env:CONTROL_PLANE_API_KEY"` — a
reference, never the key itself.

```bash
export CONTROL_PLANE_API_KEY="sk-..."
tunnel-client doctor --profile context-bridge   # expect: RESULT pass
tunnel-client run --profile context-bridge
```

### 4. Add the connector

Keep the daemon running — ChatGPT needs it up both for connector discovery and for every later
tool call. In ChatGPT: **Settings → Apps → Advanced → Developer mode**, add a developer-mode app,
choose **Tunnel** under Connection, and select your tunnel. Then, in a new chat with
developer-mode tools enabled:

> What should we do next with corpus? Use Context Bridge.

A grounded answer cites live git state and allowlisted documents, and separates them from
anything an agent recorded. If it answers without calling a tool, it is guessing.

### Public HTTPS is not the default

ChatGPT can also import a public `https://…/mcp` URL. Because it cannot attach an API key, that
endpoint is readable by anyone who learns the URL. This repository ships no public unauthenticated
server and no OAuth 2.1 authorization server. Do not put a generic tunnel (ngrok, Cloudflare) in
front of this process unless you accept that your allowlisted repository text becomes reachable to
whoever has the link.

---

## MCP tools

| Tool | Use when |
|---|---|
| `context_list_projects` | Discover configured project names |
| `context_project_briefing` | **Hero for strategy** — live git + docs + tasks + handoffs + blockers + next actions, with provenance |
| `context_project_snapshot` | Live repo/worktree/session detail |
| `context_list_worktrees` / `context_worktree_snapshot` | Parallel worktrees |
| `context_recent_changes` / `context_compare` | History and branch divergence |
| `context_search` | Locate text; returns file/line/preview |
| `context_list_context_documents` / `context_read_context_document` | Allowlisted docs only |
| `context_list_agent_sessions` / `context_session_snapshot` | Session artifacts if configured |
| `context_task_upsert` / `context_task_list` / `context_task_get` | Durable tasks (stdio; HTTP writes off by default) |
| `context_handoff_create` / `context_handoff_list` / `context_handoff_get` | Agent handoffs with canonical vs asserted git state |

Tool names use underscores (`context_project_briefing`). MCP itself permits dots, but
OpenAI validates function names against `^[a-zA-Z0-9_-]+$` and rejects the dotted form,
so the dotted names used before 0.3 are no longer advertised. They are still accepted on
`tools/call` for existing stdio clients and skills.

`context_project_briefing` is designed for:

> “Look at the current state of Corpus and tell me what we should work on next.”

It does not generate an essay. It assembles observed git/docs and stored task/handoff records, and labels each claim as `live_observation` or `agent_record`.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `CONTEXT_BRIDGE_CONFIG` | Config file path |
| `CONTEXT_BRIDGE_STATE_DIR` | Task/handoff state directory (outside project roots unless you opt in) |
| `CONTEXT_BRIDGE_TOKEN` | Bearer token for Streamable HTTP |
| `CONTEXT_BRIDGE_HTTP_WRITES=1` | Allow task/handoff writes on HTTP |
| `CONTEXT_BRIDGE_HTTP_HOST` / `CONTEXT_BRIDGE_HTTP_PORT` | HTTP bind defaults |
| `PLUGIN_DATA` | Plugin data directory (config location) |

Config search order without an explicit path: `CONTEXT_BRIDGE_CONFIG`, `$PLUGIN_DATA/config.yaml`, `$XDG_CONFIG_HOME/context-bridge/config.yaml`, then cwd variants.

---

## Data / storage

- Config: `~/.config/context-bridge/config.yaml` by default
- State: `$XDG_STATE_HOME/context-bridge` or `~/.local/state/context-bridge` (or `CONTEXT_BRIDGE_STATE_DIR`)
- Records: `tasks/*.json` and `handoffs/*.json`, mode `0600`, directories `0700`
- Filenames are hashes of `(kind, project, id)` — IDs cannot become paths

Legacy `.context-bridge-state` next to a project-root config remains discoverable if it already exists.

---

## Security

Private repository text must not become a public MCP endpoint.

Controls:

- Explicit project allowlist + `realpath` containment
- Secret/binary denylist (`.env`, keys, `.ssh`, `.aws`, tokens, …)
- Read-only git via `execFile` (no shell, no checkout/commit/push)
- HTTP binds `127.0.0.1` by default
- HTTP requires a bearer token unless `--allow-anonymous` on loopback
- Non-loopback binds refuse to start without a token and refuse `--allow-anonymous`
- HTTP write tools are hidden/disabled by default
- Host-header check against the bind address
- Tool results are not written to logs

See `THREAT_MODEL.md` and `SECURITY.md`.

---

## Testing the connection

```bash
npm test                 # unit + integration + continuity/HTTP e2e
npm run typecheck
node dist/cli/index.js doctor
curl -sS http://127.0.0.1:8787/healthz
```

The e2e suite proves:

1. Agent A records a task/handoff in a disposable repo
2. Fresh Agent B reconstructs that work from the project name and completes the recorded next action
3. A Streamable HTTP client with no memory can answer “what is this / what happened / what is unfinished / what should be decided next”

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Tools say no configuration | `context-bridge init`, then `CONTEXT_BRIDGE_CONFIG` |
| Project not found | Name must match `projects[].name` exactly |
| Document not readable | Path must match that project's `context` globs and pass the denylist |
| HTTP 401 | Send `Authorization: Bearer $CONTEXT_BRIDGE_TOKEN` |
| HTTP 421 | `Host` header does not match the loopback bind |
| ChatGPT cannot see the server | Developer mode on, `tunnel-client run` still in the foreground, tunnel selected in the connector |
| `doctor` fails `control_plane_api_key` | `CONTROL_PLANE_API_KEY` is unset in the shell running the daemon |
| Tunnel authenticates but no tools appear | Runtime key needs the **Tunnels: Read + Use** scope; `Read only` is not sufficient |
| `invalid tunnel ID` | Must be `tunnel_` followed by 32 lowercase hex characters |
| Fresh agent ignores previous work | It must call `project_briefing` / `task_list` / `handoff_list` — the server does not inject memory into new chats |
| Stale handoff | `handoff_get` / briefing `caveats` — compare `agent_record` vs live git |

---

## Development

```bash
npm run build
npm run typecheck
npm test
npm run lint
```

Tests use synthetic temporary repos. They never require a private Corpus checkout.

---

## Changelog

See `CHANGELOG.md`. Note that 0.3.0 renamed every MCP tool from `context.<name>` to `context_<name>`
so that OpenAI-style function-name validation accepts them; the dotted names still dispatch but
are no longer advertised.

---

## License

Apache-2.0 — see `LICENSE`.
