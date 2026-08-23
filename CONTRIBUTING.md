# Contributing to Context Bridge

Thanks for helping build a local-first continuity and bounded observation layer for agentic development.

## Ground rules

- **Greenfield only** — do not depend on private Corpus code; the plugin must remain self-contained.
- **Repository observation is read-only** — no mutation of repos, branches, worktrees, or agent sessions. The only writes are validated task/handoff records in the separate state directory. See `THREAT_MODEL.md`.
- **Explicit allowlist** — never add general filesystem access. Narrow globs beat `**/*`.
- **Bounded outputs** — every new data path that can grow unbounded must have a cap and a `truncated` flag.
- **No shell** — git and other subprocesses must use `execFile` with allowlisted arg arrays.

## Development setup

```bash
git clone https://github.com/Renaissance-AI-Solutions/consistorium
cd consistorium
npm install --cache /tmp/npm-cache  # or plain npm install
npm run build
npm run typecheck
npm test
npm run lint
```

After `npm run build`, connect any MCP client using the portable form documented in `README.md`:

```bash
hermes mcp add consistorium \
  --command node \
  --args /portable/path/context-bridge/dist/mcp/server.js \
  --env CONTEXT_BRIDGE_CONFIG=/portable/path/context-bridge-config.yaml \
  --env CONTEXT_BRIDGE_STATE_DIR=/portable/path/context-bridge-state
```

After `npm run build`, `node dist/cli/index.js doctor` should smoke the configured briefing. The continuity path is `context_task_upsert` / `context_handoff_create` on stdio, then a fresh client reconstructs via `context_project_briefing`. Confirm handoff `repositoryState.canonical` is live and assertions never replace it.

## Tests

Tests create **synthetic temporary git repositories** under `os.tmpdir()` per test (see `src/__tests__`). They never require the Corpus repo or network access.

```bash
npm test                 # vitest run
npm run typecheck        # must pass
```

Add tests for any new security-relevant boundary (see `THREAT_MODEL.md §7`).

## Project layout

See `DESIGN.md §7`. `src/core/continuity.ts` is intentionally a narrow structured store; do not add arbitrary file or command tools.

## Commit style

- Incremental, reviewable commits at meaningful milestones.
- Keep the working tree clean (`git status --short` empty) before submitting.
- Do not commit `dist/` or `node_modules/`.

## Reporting security issues

Do **not** open a public issue. See `SECURITY.md`.

## Code of conduct

Be kind and direct. Prefer technical precision over performative positivity. Assume good intent, but verify behavior with tests.

## License

By contributing, you agree your contributions are licensed under the Apache License 2.0.
