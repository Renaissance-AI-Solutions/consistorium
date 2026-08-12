---
name: project-state
description: Establish live development reality via Context Bridge before giving strategic advice — inspect repo state, worktrees, changes, docs, and sessions.
version: 0.1.0
---

# Project State — Establish Reality Before Advice

This skill teaches an AI how to use **Context Bridge** to ground its answers in observed local development state rather than assumptions.

## When to use

Use this skill whenever the user asks for strategic, architectural, or prioritization advice about their codebase and you have access to Context Bridge MCP tools.

Examples:
- "What should I work on next?"
- "Is this architecture still correct?"
- "Are we ready to release?"
- "What is happening in this repo?"
- "Give me a project snapshot before I decide."

## Workflow

Follow these steps in order. Prefer snapshots and summaries before requesting large raw diffs.

### 1. Discover projects

Call `context.list_projects` to see which projects are explicitly configured and whether each is a git repository.

### 2. Get the hero snapshot

Call `context.project_snapshot` for the primary project.

This single tool answers a large fraction of "what is actually happening?":

- canonical path, git branch, HEAD, dirty/clean
- every worktree with staged/unstaged/untracked changes and ahead/behind
- recent commits (with subjects), changed-file stats, diff stat
- allowlisted context documents (TODO.md, ROADMAP.md, ADRs, reports)
- agent/session artifacts (normalized harness/model/state/title/timestamps)

Report **provenance and freshness** (`provenance.observedAt`). If the snapshot is stale or the project is dirty, say so.

### 3. Surface parallel work

If `worktrees.length > 1` or any worktree `isDirty`:

- Call `context.list_worktrees` for full detail if you need it.
- Highlight which worktrees contain uncommitted changes.
- Never assume `main` reflects the full development state. Check every worktree's branch and HEAD.

For a specific worktree that looks important, call `context.worktree_snapshot`.

### 4. What changed recently?

If the user asks about history, use `context.recent_changes`:

- default is the main project root; pass `worktreePath` to scope to a worktree.
- keep `limit` small (10–20) initially; increase only if needed.

### 5. Compare before concluding

If you need to know what diverges between branches:

- Call `context.compare` with `base` and `target` refs (e.g., `main` vs `feature/x`).
- Do **not** set `includeDiff: true` unless the user explicitly wants diff text.
- When you do include diffs, keep `maxDiffBytes` bounded (default 128 KiB is usually enough).

### 6. Read context documents deliberately

- Call `context.list_context_documents` to see what is allowlisted.
- Then call `context.read_context_document` for the one or two most relevant documents.
- Do **not** recursively enumerate the repository — only documents matching the user's configured allowlist are readable. If a file is not listed, it is intentionally unavailable.
- Treat "not allowlisted" and "denied by security policy" as intentional boundaries, not errors to work around.

### 7. Check agent/session state

- Call `context.list_agent_sessions` (optionally filtered by project).
- For an interesting session, call `context.session_snapshot`.
- Treat unknown fields as unknown — do not hallucinate harness, model, or state.
- Session previews are bounded and redacted; do not assume you have the full log.

### 8. Use search when you need location, not blobs

- Call `context.search` for precise code/text location.
- You get `path`, `line`, `column`, and a single-line `preview` per hit — not whole files.
- Respect the `truncated` flag: there may be more matches than returned.

## Rules of evidence

1. **Distinguish observed facts from inference.** Say "observed" when citing tool output, "inferred" when reasoning beyond it.
2. **Consider stale observations.** Every response includes `observedAt`. If the user has been coding since then, note that the snapshot may be stale and offer to re-fetch.
3. **Prefer structured summaries before raw detail.** Do not dump enormous diffs into context. Use `diffStat` and `changedFiles` first.
4. **Do not assume `main` is the source of truth.** Parallel worktrees may hold the most important unmerged work.
5. **Honor allowlisting.** If a document or path is not available, explain that it is outside the configured/accessible scope rather than attempting filesystem bypasses.
6. **Do not request or repeat secrets.** Context Bridge redacts and denies secret files. Never try to widen access to `.env`, keys, or credential files.

## Example (condensed)

```
1. context.list_projects -> { projects: [{ name: "myapp", canonicalPath: "/Users/me/dev/myapp", isGitRepo: true }] }
2. context.project_snapshot { project: "myapp" } -> { git: { branch: "feature/auth", isDirty: true }, worktrees: [...], recentChanges: {...} }
   - Observed: branch is feature/auth, dirty, 2 worktrees, 3 uncommitted files in worktree /tmp/wt-fix.
3. context.list_context_documents { project: "myapp" } -> { documents: [{ path: "TODO.md" }, { path: "docs/architecture.md" }] }
4. context.read_context_document { project: "myapp", path: "docs/architecture.md" } -> ...
5. Synthesize: "Observed: ... Inferred: ... Recommendation: ..."
```

## What this skill is NOT

- Not an orchestrator — it does not launch agents, mutate branches, or create worktrees.
- Not a publish step — do not auto-publish session artifacts or code.
- Not a replacement for `git` CLI when the user explicitly wants to run git themselves; Context Bridge is read-only.

## Future concept (not implemented)

**session-to-content** — analyzing session artifacts for shareable engineering lessons while aggressively redacting private code, secrets, and unreleased details. This is roadmap material only; do not implement automatic publishing in v0.1. See `ROADMAP.md`.

## Reference

- Configuration: `~/.config/context-bridge/config.yaml` or `$PLUGIN_DATA/config.yaml` or `CONTEXT_BRIDGE_CONFIG`
- Security: see `THREAT_MODEL.md` and `SECURITY.md`
- All tools return `provenance.observedAt` — include it when summarizing
