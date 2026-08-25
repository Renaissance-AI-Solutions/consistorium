# Changelog

All notable changes to Consistorium are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] — 2026-08-25

### Added

- Public launch release. Consistorium is now installable from npm with
  `npm install -g consistorium`.
- `consistorium serve --read-only`: stdio mode with the task/handoff write tools hidden — the
  recommended surface for ChatGPT connections.
- A copy-paste AI-agent installation handoff for local MCP clients, private ChatGPT planning
  connections, and evidence-driven repair of an existing connection (docs/agent-install.md).
- A release-package check that keeps CLI/MCP/plugin versions aligned and verifies that the npm
  tarball contains its binaries, skills, and setup documentation; CI now packs, globally installs
  the tarball into a fresh prefix, and smoke-tests the read-only MCP surface from the installed
  binary.

### Changed

- ChatGPT setup uses OpenAI Secure MCP Tunnel's managed stdio runtime with
  `consistorium serve --read-only`; no separate local HTTP server is required.
- Runtime credentials are stored in a user-only file and referenced with `file:`. Setup material
  never asks users to paste a key into chat, command text, shell history, or documentation.
- The npm source fallback builds before global installation, and package builds run automatically
  during packaging.
- Documentation now uses a neutral "Project Context" example name for the ChatGPT developer-mode
  app instead of an internal product name.
- User-facing log lines consistently use the `[consistorium]` prefix.
- **Rename completed everywhere.** Configuration, environment variables, and default paths now
  use the Consistorium name: `CONSISTORIUM_CONFIG`, `CONSISTORIUM_STATE_DIR`, `CONSISTORIUM_TOKEN`,
  `CONSISTORIUM_HTTP_WRITES`, `CONSISTORIUM_HTTP_HOST`/`_PORT`, `~/.config/consistorium/`,
  `~/.local/state/consistorium/`, `./consistorium.yaml`, and `.consistorium/` project folders.
  All pre-0.4 `CONTEXT_BRIDGE_*` variable names and `context-bridge` locations remain supported
  as automatic fallbacks; when both are set, `CONSISTORIUM_*` wins. Existing installs keep
  working without changes.

## [0.3.0] — 2026-08-19

First release intended for public use. The tool rename below is breaking.

### Changed — naming

- **The project is named Consistorium.** The published npm package is `consistorium`, the CLI
  entrypoint is `consistorium`, and the MCP `serverInfo.name` is `consistorium`. Internal
  identifiers keep their historical names for compatibility: the `context_*` tool prefix, the
  `CONTEXT_BRIDGE_*` environment variables, and the `~/.config/context-bridge/` configuration
  directory are unchanged in 0.3.x.

### Changed — breaking

- **MCP tool names now use underscores.** `context.project_briefing` became
  `context_project_briefing`, and likewise for all 18 tools. MCP permits dots in tool names, but
  OpenAI validates function names against `^[a-zA-Z0-9_-]+$` and rejects the dotted form, so no
  dotted tool could be called from ChatGPT or the Responses API. The dotted names are still
  accepted by `tools/call` so existing stdio clients and skills keep working, but they are no
  longer advertised in `tools/list` and may be removed in a later release. Update any hard-coded
  tool names.

### Fixed

- **Context-document discovery no longer crashes on large repositories.** Subtree results were
  collected with `results.push(...sub)`, which throws `RangeError: Maximum call stack size
  exceeded` once a directory holds more entries than V8 accepts as spread arguments. A repository
  with ~195,000 files in a single directory failed after ~24 seconds. The walker is now a
  streaming async generator.
- **Discovery no longer walks the whole project tree.** Each pattern is now resolved against the
  only tree it can match: a pattern with no glob magic names exactly one file and is resolved by a
  direct stat, and a glob is walked from its static prefix only (`docs/**/*.md` starts at `docs/`).
  A 20,000-entry scan budget bounds pathological patterns. A 280,000-file repository went from
  crashing after 24s to resolving in 0.07s.
- **Project briefings reach the architecture document.** Documents were loaded from a flat list
  capped at four, so `TODO.md`, `ROADMAP.md`, and `IDEA.md` could consume every slot before an
  architecture document was tried, leaving the `architecture` field empty on repositories that
  had one. Loading is now ordered by role, so the purpose and architecture slots fill first.
- The `instructions` string returned at `initialize` named the server "Connect Bridge".

### Changed

- **Context patterns match the path relative to the project root only.** A literal pattern such as
  `TODO.md` previously also matched by basename at any depth, so `vendor/nested/TODO.md` was
  surfaced by a pattern that names a root file. That made the allowlist hard to predict; patterns
  have always been documented as root-relative.
- Symlinked directories inside a project root are now traversed during discovery, with containment
  and denylist checks applied to the resolved target. They were previously skipped by accident,
  because `lstat` on a symlink never reports `isDirectory()`.

## [0.2.0] — 2026-08-12

- Added durable task and handoff continuity: `task_upsert`, `task_list`, `task_get`,
  `handoff_create`, `handoff_list`, `handoff_get`, backed by a local state directory outside
  inspected repositories.
- Added `project_briefing`, which combines live git state, allowlisted document excerpts, open
  tasks, recent handoffs, blockers, and recorded decisions into one response, labelling every
  claim as `live_observation` or `agent_record`.
- Added the Streamable HTTP transport at `/mcp`, bound to loopback and bearer-authenticated by
  default, with write tools hidden unless explicitly enabled.
- Split the transport-agnostic core into `src/mcp/app.ts` so stdio and HTTP share one
  implementation.
- Fixed continuity persistence conflicts and preserved discovery of legacy state directories.
