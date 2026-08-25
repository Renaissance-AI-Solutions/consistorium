# Consistorium

[![CI](https://github.com/Renaissance-AI-Solutions/consistorium/actions/workflows/ci.yml/badge.svg)](https://github.com/Renaissance-AI-Solutions/consistorium/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

> **Your strategist AI can't see your codebase. Fix that.**

Consistorium is a local-first MCP server that gives any conversational model — ChatGPT included — grounded, current intelligence about the repositories your coding agents are actually working in: live git state, allowlisted documents, durable tasks, and agent-to-agent handoffs.

**Use your best reasoning model as the general. Save coding agents for code.** Coding-agent time is scarce — metered in five-hour windows, weekly caps, and credit packs — yet much of it is spent re-discovering what already exists: repo structure, branch state, decisions made yesterday. Consistorium reverses the flow: your conversational strategist reads live project state on demand, decides what should happen next, and hands coding agents work so precise they never have to explore.

No more pasting `git log` output into chat. No more stale summaries. Your coding agents do the work; Consistorium lets your best reasoning model see it.

## The problem

Multi-model development has a structural gap:

- **Coding agents** (Claude Code, Codex, Cursor, Hermes) hold the repository.
- **Strategic reasoning** often happens elsewhere — a long-running ChatGPT conversation that knows your goals but not your code.
- Today the only bridge is copy-paste: git output, file excerpts, hand-written status reports — all stale the moment they're pasted.

Consistorium closes the gap in the other direction: instead of dragging your strategist into the terminal, it exposes **bounded, read-only project intelligence** to any MCP client — with every claim labeled as either `live_observation` (git facts read right now) or `agent_record` (what a previous agent claimed when it left). Generated memory never masquerades as ground truth.

## 30-second quickstart

> Requires Node.js 20+ and `git` on `PATH`.

```bash
npm install -g consistorium

# Allowlist a project (this is the only thing the server can ever inspect)
consistorium init --path ~/dev/my-project --name my-project --yes
consistorium doctor        # verifies config + smokes a live briefing
```

If npm returns `E404` before the first registry release, use the source-install fallback in
[docs/install.md](docs/install.md). Do not confuse `npm install` inside a checkout (dependencies
only) with `npm install -g .` (installs the CLI).

Point any stdio MCP client at it:

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

Works with Claude Desktop, Claude Code, Codex, Cursor, Windsurf, Hermes, and any other MCP-compatible client. For **ChatGPT** (which connects over the network rather than stdio), see [docs/chatgpt-setup.md](docs/chatgpt-setup.md). Full walkthrough for every client, troubleshooting, and uninstall: **[docs/install.md](docs/install.md)**.

Want an agent to do it? Give a coding agent the appropriate copy-paste handoff in
**[docs/agent-install.md](docs/agent-install.md)**. It installs, preserves existing configuration,
registers the MCP server, and must prove success with a real tool call. For ChatGPT, the only
unavoidable human actions are approving the restricted OpenAI runtime key, copying it to the local
clipboard, and—when browser policy requires it—pressing **Send** on the staged verification prompt.

Then ask your client:

> *What changed in my-project today, what remains before release, and what should I ask my coding agent to do next?*

A grounded answer comes back citing live branch state and allowlisted docs — separating observed facts from anything an agent recorded. If the model answers without calling a tool, it's guessing.

## One-prompt setup for AI agents

Don't want to touch a terminal? Paste this short handoff into a coding agent with terminal access:

```text
Open https://github.com/Renaissance-AI-Solutions/consistorium/blob/main/docs/agent-install.md.
Use Prompt A to install Consistorium for this repository and your own MCP client. Perform the
steps instead of returning a tutorial, preserve existing configuration, and do not claim success
until context_list_projects and context_project_briefing work through the client.
```

For ChatGPT as the planning agent, use **Prompt B** in
[docs/agent-install.md](docs/agent-install.md). If an existing Project Context card is visible but
not callable, use **Prompt C** before deleting anything or rotating a key.

## What it does

| Tool | Use when |
|---|---|
| `context_project_briefing` | **The hero call** — live git + docs + open tasks + latest handoffs + blockers + next actions, provenance-labeled |
| `context_project_snapshot` | Live repo/worktree/session detail |
| `context_list_worktrees` / `context_worktree_snapshot` | Parallel worktrees and multi-agent activity |
| `context_recent_changes` / `context_compare` | History and branch divergence |
| `context_search` | Bounded text search across allowlisted roots |
| `context_read_context_document` | Read only explicitly allowlisted documents |
| `context_task_*` / `context_handoff_*` | Durable task records and structured agent handoffs |

The continuity model: an execution agent calls `context_task_upsert` when it starts work and `context_handoff_create` when it leaves — objective, decisions, evidence, blockers, canonical-vs-asserted git state, and a requested next action. A **fresh** agent with no conversation history calls `context_project_briefing` and continues without the human reconstructing anything.

## Why not just give the model repo access?

Claude Code and Codex already *have* the repository — that's not the gap. The gap is the model that *doesn't*: your strategist, reviewer, or planner sitting outside the harness. Cloning the repo into a chat session copies megabytes of context you don't control and can't bound. Consistorium is the deliberate, read-only, allowlisted pipe for exactly the intelligence a strategist needs — nothing more.

And unlike "give ChatGPT your terminal" bridges, Consistorium executes no commands, mutates nothing, and cannot widen its own access. See the [security model](#security-model).

## Security model

Private repository text must never become a public endpoint.

- **Explicit allowlist** — only configured project roots are ever inspected (`realpath`-canonicalized; traversal and symlink escapes denied)
- **Secret denylist** — `.env`, keys, `.ssh/`, `.aws/`, credential-named files are refused even if globs would match
- **Read-only git** — hardened `execFile` invocations only; no shell, no checkout/commit/push, ever
- **Bounded outputs** — capped reads, diffs, search results, and record sizes; truncation is flagged, never silent
- **Loopback-only HTTP by default** — Streamable HTTP binds `127.0.0.1`, requires a bearer token, refuses anonymous non-loopback binds, and hides write tools unless explicitly enabled
- **Provenance labels** — `live_observation` vs `agent_record`, so agent claims can be checked against git reality
- **No telemetry** — nothing leaves your machine except what your own MCP client sends

Full details: [THREAT_MODEL.md](THREAT_MODEL.md) · [SECURITY.md](SECURITY.md)

## Connecting clients

### Claude Desktop / Claude Code / Cursor / Codex / Windsurf

Use the JSON snippet above. After editing, restart the client.

### Hermes

```bash
hermes mcp add consistorium \
  --command consistorium \
  --args serve \
  --env CONTEXT_BRIDGE_CONFIG=$HOME/.config/context-bridge/config.yaml
```

### ChatGPT

ChatGPT connects through OpenAI's Secure MCP Tunnel. The recommended setup lets the tunnel client
launch Consistorium over stdio, leaving only one long-lived runtime to supervise. The complete
walkthrough — tunnel installation, runtime key scoping, developer-mode connector setup, and
troubleshooting — lives in [docs/chatgpt-setup.md](docs/chatgpt-setup.md). Short version:

```bash
tunnel-client runtimes connect \
  --alias consistorium \
  --tunnel-id tunnel_YOUR_ID \
  --runtime-api-key file:/ABSOLUTE/PATH/TO/runtime-key \
  --mcp-command "consistorium serve --read-only"
```

Never paste the runtime key into chat or command text. The tunnel ID identifies the connection; it
is not the key. Secure MCP Tunnel is for a private developer-mode connection and must remain
running for discovery and tool calls. It does not make Consistorium a public Plugin Directory
listing; that would require a separate hosted HTTPS service and per-user authentication.

## Environment variables

| Variable | Purpose |
|---|---|
| `CONTEXT_BRIDGE_CONFIG` | Config file path |
| `CONTEXT_BRIDGE_STATE_DIR` | Task/handoff state directory (kept outside project roots by default) |
| `CONTEXT_BRIDGE_TOKEN` | Bearer token for Streamable HTTP |
| `CONTEXT_BRIDGE_HTTP_WRITES=1` | Allow task/handoff writes on HTTP (off by default) |

Records are written `0600` under a `0700` state directory; filenames are hashes, IDs never become paths.

## Testing

```bash
npm test            # 125+ tests: security boundaries, transports, Agent A→B continuity e2e
npm run typecheck
consistorium doctor
```

Tests run against synthetic temporary repositories — no private checkouts required.

## The story

Consistorium was built and battle-tested while operating [Corpus](https://corpuslaw.us) — an AI-native legal platform that compiles US law into a free public library and forms companies in all 50 states. Every strategic decision on Corpus runs through this exact loop: coding agents implement, Consistorium reconstructs project state, and a conversational strategist reasons over live engineering reality instead of pasted summaries. The tool exists because we needed it daily.

## Documentation

- [docs/install.md](docs/install.md) — complete installation guide for every client
- [docs/agent-install.md](docs/agent-install.md) — prompts that let an AI agent install and verify it
- [docs/chatgpt-setup.md](docs/chatgpt-setup.md) — ChatGPT connection via Secure MCP Tunnel
- [docs/release-checklist.md](docs/release-checklist.md) — launch gates and clean-machine tests
- [DESIGN.md](DESIGN.md) — architecture and data flow
- [THREAT_MODEL.md](THREAT_MODEL.md) — assets, adversaries, mitigations
- [SECURITY.md](SECURITY.md) — reporting policy and safe usage
- [ROADMAP.md](ROADMAP.md) — shipped vs designed vs explicitly not planned
- [CONTRIBUTING.md](CONTRIBUTING.md) — ground rules and development setup
- [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0 — see [LICENSE](LICENSE).
