# Roadmap

This roadmap separates **working now** from **designed for later**. Nothing listed under "Later" is claimed as shipped.

## Working now (v0.1 MVP)

- Agent Plugins v1.0 packaging: `plugin.json`, `mcp.json` (stdio), `skills/project-state/SKILL.md`
- Configuration: YAML/JSON, XDG + `PLUGIN_DATA` + `CONTEXT_BRIDGE_CONFIG` resolution, `context-bridge init` (interactive + flags), `config show` / `config validate`
- Security: explicit allowlist, `realpath` canonicalization, `..` traversal denial, symlink escape prevention, exact `.git` deny rule, secret-file denylist, binary skip, bounded outputs, hardened allowlisted `execFile` git, explicit unavailable states, and external-worktree boundaries
- Providers: git (worktree discovery, dirty/staged/untracked, branch/HEAD/detached, ahead/behind, recent commits, diff stat, bounded diff, merge-base), documents (discovery + bounded read), search (bounded plain-text)
- Context plane: `ContextService` plus `ContinuityStore` behind a transport-agnostic facade
- Continuity: bounded durable task/handoff JSON outside configured repositories by default, atomic writes, restrictive permissions, runtime Zod validation, canonical-vs-asserted Git state, refresh/staleness reporting
- MCP: 17 tools over stdio, including `task_upsert`, `task_list`, `task_get`, `handoff_create`, `handoff_list`, and `handoff_get`, with compact progressive retrieval
- Skill: `project-state` (project → task → latest handoff → detail → direct verification)
- Tests: security, config, git, documents, search, sessions, MCP, continuity, and external-worktree acceptance coverage on synthetic tmp fixtures
- Tooling/docs: ESLint 9 flat config, README, THREAT_MODEL, DESIGN, SECURITY, CONTRIBUTING, LICENSE, example config, and Hermes CLI setup

## Next (v0.2 — security & coverage hardening, no scope creep)

- Fuzz path containment with adversarial fixture trees (long symlink chains, case-insensitive fs edges, unicode normalization)
- Property-based tests for truncation invariants
- Optional `includeIgnored` / `excludeGlobs` flags on search (already internal, just not exposed as MCP args yet)
- Per-project limit profiles beyond the current global bounded config
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

### Outsourcerer adapter/integration

Outsourcerer is future adapter work. The current MVP does not launch it, route tasks through it, or treat it as canonical agent provenance. A future adapter may record an explicitly supplied harness/session identity after a threat review.

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
- Kanban / scheduling / generic task-management mutation (structured continuity records are already supported)
- Cloud backend / SaaS / telemetry
- General-purpose filesystem MCP (that would defeat allowlisting)

## How to propose an item

Open an issue describing the use case, the minimal read-only surface it needs, and its security implications. Features that would mutate state or widen filesystem access start with a threat-review.
