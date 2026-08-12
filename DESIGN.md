# Design — Context Bridge

## 1. Purpose

Context Bridge is a **vendor-neutral, passive, local-first, read-only development-context plane** for AI agents.

It answers *"What is actually happening in my development environment right now?"* without becoming an agent launcher, orchestrator, or task system.

The differentiator is **observability, not control** — OpenTelemetry for agentic development state, exposed through MCP.

---

## 2. Non-goals

- No agent orchestration (launch/terminate/send terminal command)
- No worktree/mutation control plane
- No Kanban/task mutation
- No web UI, auth/accounts, SaaS backend
- No embeddings/vector search in v0.1
- No database in v0.1 (lightweight local state only)

---

## 3. Architecture decisions

### 3.1 TypeScript / Node for the MVP

Chosen for:

- MCP SDK maturity (`@modelcontextprotocol/sdk`)
- Broad client compatibility (stdio launch via `node`)
- Easy packaging for Agent Plugins (JS is portable to most hosts)
- Clean migration path to a compiled binary (Rust/Go) later — the **core contracts** (`ContextService`, providers, adapters) are deliberately transport- and language-agnostic

### 3.2 Three-layer stack

```
MCP transport (src/mcp)
      ↓
ContextService (src/core/context.ts) — THE PORTABLE CORE
      ↓
Providers (git, docs, search) + Adapter interface (sessions) + Security/Config
```

- `ContextService` has **no MCP dependency**; it can be imported by a future Streamable HTTP server, CLI, or compiled binary.
- Providers are pure functions / classes with explicit inputs (canonical paths, policy) and structured outputs.
- Adapters implement `SessionAdapter { listSessions, getSessionSnapshot }`. Adding Codex/Claude adapters means adding a file under `src/adapters/`, not editing core.

### 3.3 Configuration: explicit allowlist only

Alternatives considered:

- **Auto-discover repos under `$HOME`** — rejected: too permissive, violates least privilege.
- **`CONTEXT_BRIDGE_CONFIG` env only** — kept as override, but discoverability matters for plugin installs (`PLUGIN_DATA`).

Chose: **explicit `projects[].path` in YAML YAMLconfig** resolved with canonical, real ` and� check, with CLI `init` that forces the user to approve each root. Defaults are secure (no project → no access). Search order prefers `$PLUGIN_DATA` and `XDG_CONFIG_HOME` so plugin installs don't pollute `cwd`.

### 3.4 Security as policy object

Rather than scattering `if (!allowed)` checks, a dedicated `SecurityPolicy` (canonical roots + `canonicalizeAndCheck`, `isInsideAllowedRoot`, `assertInside`) is constructed once from config and threaded through every provider. Providers also call `isDeniedByPolicy` for secret/binary denylisting. This makes invariants testable and reviewable in one file.

### 3.5 Git via allowlisted execFile

Rejected:

- `shell: true` + string interpolation — injection hazard
- `isomorphic-git` (pure JS) — loses fidelity on worktree discovery and diff behavior; `git` CLI is the reference

Chose: `execFile("git", argsArray)` with an **explicit allowlist** of read-only subcommands and a ref-validation regex for user-supplied refs. `maxBuffer` and `timeout` bound each call.

### 3.6 Bounded outputs with `truncated` signals

Every provider that can return variable-length data caps it:

- documents: 256 KiB, diffs: 128 KiB, search: 100 hits, commits: 100, untracked preview: 50, file scan per search: 512 KiB max.

Callers see `truncated: true` and can decide whether to refine the query. This prevents model-context blow-up and DoS.

### 3.7 Project snapshot as hero tool

Instead of requiring 20 tool calls to answer "what's going on?", `context.project_snapshot` aggregates branch, worktrees, recent commits, docs, and sessions in one structured call. Other tools exist for drilling down. The skill `project-state` directs the model to call `project_snapshot` first.

---

## 4. Data models

All models live in `src/core/types.ts` and share:

- `provenance: { observedAt: string, projectName?, projectPath? }` on every top-level response
- ISO 8601 timestamps
- Bounded arrays and `truncated` flags
- `canonicalPath` (realpath) alongside user-visible `path`

Key types:

- `ProjectSnapshot` — aggregates `ProjectInfo`, `GitRepoState`, `WorktreeInfo[]`, `ContextDocSummary[]`, `RecentChanges`, `SessionSummary[]`
- `WorktreeInfo` — per-worktree branch, HEAD, dirty flag, staged/unstaged/untracked, ahead/behind
- `RecentChanges` — commits, changed-file stats, diff stat
- `CompareResult` — merge-base, ahead/behind, commits, diff stat, optional bounded diff
- `SessionSummary` / `SessionSnapshot` — normalized harness/model/state/title/timestamps with bounded redacted preview

---

## 5. MCP API

Avoided dozens of tiny tools. Chose 11 coherent, high-value tools (all `context.*`):

```
list_projects, project_snapshot,
list_worktrees, worktree_snapshot,
recent_changes, compare,
search,
list_context_documents, read_context_document,
list_agent_sessions, session_snapshot
```

All tools:

- Have JSON Schema `inputSchema` (draft 2020-12 style), `additionalProperties: false`
- Validate required fields early and return `{ error, code }` with `isError: true` rather than throwing unstructured
- Include `provenance` so the model knows freshness and can reason about staleness

Naming follows `context.<noun>_<verb>` for coherence; `project_snapshot` is intentionally the most capable.

---

## 6. Agent Skills

### 6.1 `project-state` (shipped)

Purpose: teach a model to ground strategic advice in observed state.

Flow: `list_projects` → `project_snapshot` (hero) → surface worktrees → `recent_changes` / `compare` → `list_context_documents` → `read_context_document` → `list_agent_sessions` → synthesize with observed/inferred separation, staleness note, and bias against "main is truth".

### 6.2 `session-to-content` (roadmap, not shipped)

Analyze session artifacts for shareable lessons while **aggressively redacting** code, secrets, customer info, and unreleased details. Documented in `ROADMAP.md` only.

---

## 7. File map

```
plugin.json               Agent Plugins v1 manifest ($schema pinned)
mcp.json                  MCP servers (stdio)
skills/project-state/     portable skill
src/
  core/
    types.ts              normalized models + DEFAULT_LIMITS
    config.ts             YAML/JSON load, zod validate, realpath resolve
    security.ts           SecurityPolicy, denylist, isDeniedByPolicy
    context.ts            ContextService — provider orchestration
  providers/
    git.ts                allowlisted git exec, worktree discovery, status, log, compare
    documents.ts          walk + glob filter + policy + bounded read
    search.ts             walk + plain-text scan + denylist + bounded previews
  adapters/
    session.ts            SessionAdapter interface + GenericSessionAdapter + Noop
  mcp/
    server.ts             stdio transport, tool dispatch, no-config helpful errors
    tools.ts              11 tool definitions (inputSchema)
  cli/
    index.ts              init / config show / config validate / serve
example-config.yaml       annotated starter config
src/__tests__/            unit + integration (security, config, git, docs, search, mcp)
```

---

## 8. Agent Plugins v1.0 conformance

Status (2026-08-11): **conformant**.

- `plugin.json` validates against `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` (`$schema` exact, `name` satisfies `^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$` without `--`/`..`, only allowlisted top-level fields).
- `mcp.json` validates against `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json` — `mcpServers` with `type: "stdio"`, `command: "./dist/mcp/server.js"` (plugin-relative), `cwd: "${PLUGIN_ROOT}"`. No `PLUGIN_ROOT`/`PLUGIN_DATA` in `env` keys. `args`/`env`/`cwd` expansion is host-handled.
- Skills at fixed `skills/*/SKILL.md` (no recursion).
- No `plugin.json` inline `mcpServers`; no alternative component discovery.
- `PLUGIN_ROOT` / `PLUGIN_DATA` semantics (spec §9) are left to the hosting client — the server reads `CONTEXT_BRIDGE_CONFIG`, `PLUGIN_DATA`, and XDG in that order, which is compatible.

Discrepancy log:

- Spec §4.1 says plugin-relative paths `MUST` begin with `./` — we use `./dist/mcp/server.js`, compliant.
- We ship `example-config.yaml` and docs at the root with permissive `additionalProperties: false` only on schemas — root files do not affect conformance.

If the published spec evolves, `plugin.json` / `mcp.json` are the only files that need schema bumping.

---

## 9. Decisions log (ambiguous requirements → choice made)

| Ambiguity | Decision | Rationale |
|-----------|----------|-----------|
| Config format | YAML primary, JSON also accepted; `yaml` lib parses both | YAML is more human-friendly for `init`; JSON keeps machine writers happy |
| Session adapter in v0.1 | Generic glob-based adapter only; no deep reverse-engineering of Codex/Claude storage | Keeps MVP vendor-neutral and useful without private formats; interface is ready for adapters |
| `mcp.json` command | `./dist/mcp/server.js` with shebang + `chmod +x` | Most portable for stdio; falls back to `node dist/mcp/server.js` via host |
| Worktree ahead/behind | `rev-list --left-right --count HEAD...@{u}` when upstream exists | Safely derivable locally without network; null when no upstream |
| Diff inclusion | Off by default; bounded and `truncated` when on | Prevents context-window abuse |
| Search semantics | Plain-text, not regex/semantic, bounded per file | Sufficient for v0.1; regex can be added later without breaking change |
| Secret redaction | Best-effort regex (`sk-`, `ghp_`, `AKIA`, private key header) | Documented as not exhaustive; denylist remains the primary control |
| Multi-project vs single | `projects: []` list; `findProjectByPath` picks longest prefix | Supports devs with multiple concurrent repos, a core thesis |
| Spaces/special chars in paths | `execFile` arg arrays preserve them; no shell quoting needed | Tested with synthetic repos containing spaces |

---

## 10. Future extensibility

- **Streamable HTTP** — `ContextService` is transport-agnostic; add `src/mcp/http.ts` that constructs the same service and maps the same tool handlers to Streamable HTTP.
- **Binary build** — `ContextService` + providers can be ported to Rust/Go; `plugin.json`/`mcp.json` packaging is unaffected.
- **Additional adapters** — implement `SessionAdapter` for Codex `~/.codex/sessions`, Claude `~/.claude/`, etc., when storage formats are stable and opt-in.

All extensions should remain **read-only, local-first, explicitly allowlisted**.

