# Contributing to Context Bridge

Thanks for helping build a read-only, local-first context plane for agentic development.

## Ground rules

- **Greenfield only** — do not depend on private Corpus code; the plugin must remain self-contained.
- **Read-only invariants are hard** — no mutation of repos, branches, worktrees, or agent sessions. See `THREAT_MODEL.md`.
- **Explicit allowlist** — never add general filesystem access. Narrow globs beat `**/*`.
- **Bounded outputs** — every new data path that can grow unbounded must have a cap and a `truncated` flag.
- **No shell** — git and other subprocesses must use `execFile` with allowlisted arg arrays.

## Development setup

```bash
git clone https://github.com/context-bridge/context-bridge
cd context-bridge
npm install --cache /tmp/npm-cache  # or plain npm install
npm run build
npm run typecheck
npm test
```

## Tests

Tests create **synthetic temporary git repositories** under `os.tmpdir()` per test (see `src/__tests__`). They never require the Corpus repo or network access.

```bash
npm test                 # vitest run
npm run typecheck        # must pass
```

Add tests for any new security-relevant boundary (see `THREAT_MODEL.md §7`).

## Project layout

See `DESIGN.md §7`.

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

