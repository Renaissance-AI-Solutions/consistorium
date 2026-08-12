# Roadmap

This roadmap separates **working now** from **designed for later**. Nothing listed under "Later" is claimed as shipped.

## Working now (v0.1 MVP)

- Agent Plugins v1.0 packaging: `plugin.json`, `mcp.json` (stdio), `skills/project-state/SKILL.md`
- Configuration: YAML/JSON, XDG + `PLUGIN_DATA` + `CONTEXT_BRIDGE_CONFIG` resolution, `context-bridge init` (interactive + flags), `config show` / `config validate`
- Security: explicit allowlist, `realpath` canonicalization, `..` traversal denial, symlink escape prevention, secret-file denylist, binary skip, bounded outputs, allowlisted `execFile` git, read-only-only
- Providers: git (worktree discovery, dirty/staged/untracked, branch/HEAD/detached, ahead/behind, recent commits, diff stat, bounded diff, merge-base), documents (discovery + bounded read), search (bounded plain-text)
- Context plane: `ContextService` orchestrates everything behind a transport-agnostic facade
- MCP: 11 tools over stdio (`list_projects`, `project_snapshot`, `list_worktrees`, `worktree_snapshot`, `recent_changes`, `compare`, `search`, `list_context_documents`, `read_context_document`, `list_agent_sessions`, `session_snapshot`) with structured JSON and `provenance.observedAt`
- Skill: `project-state` (reality-before-advice workflow)
- Tests: security, config, git, documents, search, sessions, MCP smoke — all on synthetic tmp fixtures
- Docs: README, THREAT_MODEL, DESIGN, SECURITY, CONTRIBUTING, LICENSE, example config

## Next (v0.2 — security & coverage hardening, no scope creep)

- Fuzz path containment with adversarial fixture trees (long symlink chains, case-insensitive fs edges, unicode normalization)
- Property-based tests for truncation invariants
- Optional `includeIgnored` / `excludeGlobs` flags on search (already internal, just not exposed as MCP args yet)
- Per-project `limits` overrides
- `context-bridge doctor` — prints `plugin.json`/`mcp.json` schema validation, effective config, roots, and a smoke `project_snapshot` without needing an MCP client

## Later (designed, not committed)

### Streamable HTTP transport

- Add `src/mcp/http.ts` reusing the same `ContextService` and tool handlers.
- Declare alongside stdio in `mcp.json` as `type: "streamable-http"`.
- No core rewrite; transport is the only new file.

### Passive agent adapters (opt-in, best-effort)

- Codex (`~/.codex/sessions` if stable), Claude Code (`~/.claude/projects` or similar), Hermes, Cline, generic terminal.
- Each is a `SessionAdapter` implementation; none become required for core value.
- All remain passive (read state, don't control sessions).

### session-to-content (skill, not auto-publish)

- Skill that analyzes session artifacts for shareable engineering lessons, failures, model comparisons, and founder insights.
- Must aggressively redact private code, secrets, customer information, and unreleased product details.
- No automatic publishing. The skill produces a **draft** for human review.
- Tracked here so the idea is not lost while v0.1 stays focused.

### Not planned

Do not expand into:

- Agent launcher / orchestrator / control plane
- Terminal command sender / session terminator
- Worktree / branch creator (git mutations)
- Kanban / task mutation
- Cloud backend / SaaS / telemetry
- General-purpose filesystem MCP (that would defeat allowlisting)

## How to propose an item

Open an issue describing the use case, the minimal read-only surface it needs, and its security implications. Features that would mutate state or widen filesystem access start with a threat-review.

