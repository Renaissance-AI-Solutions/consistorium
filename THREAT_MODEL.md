# Threat Model — Consistorium

## 1. System boundary

Consistorium sits between **an AI agent (MCP client)** and **the developer's local filesystem / git repositories**, with a separate local continuity state directory.

- The agent is **untrusted** with respect to the filesystem: it may be prompted adversarially or hallucinate paths.
- The filesystem is **trusted** but contains sensitive data (secrets, keys, private repos).
- The plugin process is **local, user-owned**. Streamable HTTP is an optional loopback listener for ChatGPT Developer mode / Secure MCP Tunnel, not a public service.

```
[ AI (untrusted prompt influence) ] --MCP--> [ Consistorium ] --read-only allowlisted git/fs--> [ Projects ]
                                              └── bounded structured writes ──> [ State outside projects ]
```

## 2. Goals

- **Confidentiality**: Do not expose files/secrets outside explicitly allowlisted scope.
- **Integrity**: Do not mutate repositories, branches, worktrees, or arbitrary files; only write validated task/handoff records to the continuity state directory.
- **Availability**: Bound outputs and timeouts so a malicious query cannot hang or OOM the host.
- **Privacy**: No telemetry, no source/model data leaves the machine in the MVP.

## 3. Assets

- User's source code
- Credentials: `.env`, `.pem`, `*.key`, `.ssh/`, `.aws/`, `.gnupg/`, tokens
- Git history including uncommitted changes and untracked files
- Agent session artifacts (may contain task details)
- Durable task and handoff records, including agent assertions and findings

## 4. Adversaries & capabilities

| Adversary | Capability |
|-----------|------------|
| Prompt-injected agent | Can call MCP tools with arbitrary string arguments (project name, path, ref, query) |
| Malicious workspace content | Can plant symlinks, special filenames, large files, binary payloads inside an allowed repo |
| Local co-tenant | Less relevant in single-user MVP; future: multi-user host |
| Network observer | Streamable HTTP is loopback + bearer by default; a public bind without auth is refused |

Assumptions:

- The OS, Node.js, and `git` binary are trusted.
- The user who runs `consistorium init` is trusted to choose allowlisted roots.
- MCP stdio is authenticated by the local client that spawned the process. Streamable HTTP requires a bearer token unless anonymous loopback is explicitly enabled.

## 5. Threats & mitigations

### 5.1 Arbitrary filesystem access

**Threat**: Agent asks to read `~/.ssh/id_rsa` or `/etc/passwd` via document-read or search.

**Mitigations**:

- **Explicit allowlisting**: Only `projects[].path` (canonicalized via `realpath`) are ever inspected. `SecurityPolicy.canonicalizeAndCheck()` denies anything outside allowed roots.
- **Document allowlisting**: `read_context_document` only serves files matching the project's `context` globs **and** inside the project root. Non-matching paths return `NOT_ALLOWLISTED`.
- **Denylist as defense-in-depth**: Even allowlisted reads are checked against `isDeniedByPolicy()` — `.env`, `*.pem`, `*.key`, `.ssh/`, `.aws/`, `.gnupg/`, `*secret*`, `*token*`, `*credential*` are denied.
- **Binary skip**: Binary extensions are denied for docs/search/sessions unless explicitly supported.

**Residual risk**: A user who allowlists `context: ["**/*"]` could widen exposure; docs warn to keep globs narrow.

### 5.2a Continuity state and record abuse

**Threat**: A prompt-injected agent attempts path traversal, oversized records, or a generic write through task/handoff tools; a repository is polluted with state files.

**Mitigations**:

- Only six structured `context.task_*`/`context.handoff_*` operations exist. There is no generic path or file-write tool.
- IDs are strict safe identifiers; storage filenames are hashes, and records are capped at 256 KiB with bounded strings/arrays.
- Default state is derived from `CONSISTORIUM_STATE_DIR` or config location and is relocated outside configured project roots when the config itself lives in a project. An in-project state path requires explicit `CONSISTORIUM_STATE_DIR`.
- Writes use a same-directory exclusive temp file, `fsync`, restrictive modes (`0700` directories, `0600` records), and rename.
- Lists return compact summaries. Full objective/transcript-like content is never injected by list calls.

**Residual risk**: The local user can explicitly select an unsafe state location or read the state directory directly; this is an intentional local-user authority boundary.

### 5.2 Path traversal (`../`) and symlink escapes

**Threat**: Agent passes `../../.ssh/id_rsa`, or repo contains `docs/evil -> /etc`.

**Mitigations**:

- Canonicalization via `realpath` with missing-tail handling: longest existing ancestor is realpath'd, then tail is appended lexically. Works for non-existent paths.
- `SecurityPolicy.isInsideAllowedRoot()` checks separator boundaries (`/a` does not allow `/ab`).
- `documents.ts` and `search.ts` both walk with `realpath` and skip symlink targets outside the project root and outside allowed roots.
- `assertInside()` is used where a base directory is known.

**Test coverage**: See `src/__tests__/security.test.ts` — traversal, symlink escape, boundary (`/foo` vs `/foobar`).

### 5.3 Shell injection via git

**Threat**: Agent passes `base: "main; rm -rf /"` to `compare`.

**Mitigations**:

- No `exec` / `spawn` with `shell: true`. All git invocations use `execFile("git", argsArray)` — no shell interpolation.
- **Allowlisting**: Only read-only subcommands are permitted (`rev-parse`, `status`, `log`, `diff`, `show`, `worktree`, `merge-base`, `rev-list`, `ls-files`, `branch`, `for-each-ref`, `remote`, `config`). Any other subcommand is rejected.
- **Ref validation**: `compare` validates `base`/`target` against `^[a-zA-Z0-9._\/\-@^{~:]+$` before use, rejecting shell metachars. Worktree paths are canonicalized and checked against allowlist before git use.
- Deny-listed flags (`--hard`, etc.) are blocked even on allowed subcommands.

**Residual risk**: Git itself can consume large output; we bound `maxBuffer` and timeouts (15s).

### 5.3a Git helper/config and canonical truth

**Threat**: Repository-local Git config invokes external diff/textconv/fsmonitor/helpers, takes an optional index lock, or a command failure is interpreted as clean.

**Mitigations**:

- All provider calls go through one hardened `execFile` wrapper with no shell, sanitized `GIT_*` environment, system/global config disabled, `GIT_OPTIONAL_LOCKS=0`, fsmonitor/hooks disabled, and external diff/textconv disabled for diff calls.
- Canonical handoff observation returns explicit `available`, `not_git`, or `unavailable` states with nullable branch/HEAD/dirty fields. A failed command cannot become `isDirty: false` or an empty canonical record.
- Agent-reported branch/HEAD/dirty values are stored under `assertion`; mismatches against canonical observation are calculated and surfaced.

### 5.4 Output exfiltration via large reads / DoS

**Threat**: Agent requests huge diff or search to OOM the model context or the host, or to stage exfiltration.

**Mitigations**:

- **Bounded reads**: `maxFileSizeBytes` (256 KiB), `maxDiffBytes` (128 KiB), `maxSearchResults` (100), `maxSearchFileSizeBytes` (512 KiB) defaults; all tools enforce caps and set `truncated: true` when exceeded.
- **Diff truncation**: `getBoundedDiff` slices on byte boundary and appends notice.
- **Search previews**: Single-line preview per hit, 300-char cap, one hit per line.
- **Untracked preview cap**: 50 files per worktree.
- **Commits cap**: 100 max.
- All `execFile` calls have `maxBuffer` and `timeout`.

### 5.5 Secret leakage via session artifacts / search

**Threat**: Session logs or search previews contain API keys.

**Mitigations**:

- **Denylisting** applies to session artifact discovery as well (same `isDeniedByPolicy`).
- **Binary skip** applies.
- **Redaction** in `adapters/session.ts`: regex redaction of `sk-...`, `ghp_...`, `AKIA...`, private-key headers. Best-effort, not a guarantee — docs state this.
- Search index respects the same denylist; secret-named files (`*secret*`, `*token*`) are excluded from search.
- Documentation advises users to keep `sessionArtifacts.patterns` narrow and to review artifacts before sharing.

**Not mitigated in v0.1**: Content-scanning of document bodies for secrets; users should not allowlist files that contain secrets.

### 5.6 Git mutation

**Threat**: Agent tricks plugin into mutating a repo (e.g., `git checkout`, `reset --hard`).

**Mitigations**:

- Only read-only git commands are allowlisted. Mutation commands (`checkout`, `reset`, `clean`, `commit`, `push`, `merge`, `rebase`, branch create/delete) are not in the allowlist and are rejected before execution.
- Even within allowed commands, destructive flags like `--hard` are blocked.
- `ContextService` and all providers are **read-only contracts**; no file writes go to inspected repos.

### 5.6a External linked worktrees

**Threat**: `git worktree list` reports a linked worktree outside the configured project root and the server then runs status/read operations against that external path.

**Mitigations**:

- Worktree metadata may be listed for orientation, but status, upstream, and snapshot inspection are skipped unless the canonical path is inside the explicitly configured project root.
- Limited entries expose `inspection: "limited"`, nullable dirty state, and a clear reason. `worktree_snapshot`, recent changes, compare, and continuity observation enforce the project-root boundary.
- `maxWorktrees` is validated and applied to discovery.

### 5.7 Configuration tampering / privilege escalation

**Threat**: Agent influences config to widen allowlist without user noticing.

**Mitigations**:

- Config is **not writable** via MCP tools. There is no `context.add_project` tool. `consistorium init` is a CLI command requiring local shell access.
- Config lives at `PLUGIN_DATA` or `~/.config/consistorium/` (pre-0.4 installs: `~/.config/context-bridge/`) — not inside inspected repos by default. Writing to inspected repos is not done unless the user explicitly runs `init --output /path/inside/repo`.
- `resolveConfigSync` canonicalizes project paths and checks existence; duplicate project names are rejected.

### 5.8 Network egress / telemetry

**Mitigations**:

- The core does not make outbound network requests, emit telemetry, or call an embeddings service. Optional Streamable HTTP is an inbound loopback listener; it requires a bearer token unless anonymous loopback is explicitly enabled, and it refuses unauthenticated non-loopback binds.
- Future Streamable HTTP will be local-first and opt-in; docs will require threat review before any remote transport.

## 6. Non-goals / accepted risks

- **Malicious `git` binary**: Out of scope — we trust the local `git`.
- **OS-level sandboxing**: We rely on OS file permissions; no chroot/pledge/seccomp in v0.1.
- **Multi-tenant isolation**: Not in v0.1 (single local user).
- **Perfect secret redaction**: Best-effort regex only; exhaustive secret detection is a non-goal for v0.1.
- **Encrypted storage**: Session previews and diffs are plaintext in local memory/conversation context; encryption at rest is not provided.
- **Local state confidentiality**: task/handoff JSON is protected by OS permissions but is not encrypted; users should choose a trusted state directory.

## 7. Verifiability

The dangerous boundaries are covered by tests that must pass before release:

- allowed-root enforcement
- path traversal rejection (`../`)
- symlink escape rejection (file and directory)
- secret-file exclusions
- binary exclusion
- shell-avoidance (allowlist + ref validation)
- bounded output (`truncated` flags)
- malformed config handling
- MCP tool schema correctness
- task/handoff persistence, bounded/atomic state, safe IDs, canonical-vs-asserted mismatch, refresh staleness, non-Git availability, and external-worktree limits

See `src/__tests__/` and `tests/` (when present) and CI gates in `CONTRIBUTING.md`.

## 8. Invariants (must not regress)

1. No MCP tool grants arbitrary filesystem read.
2. No path is read without `realpath` canonicalization and allowlist check.
3. No git command leaves the allowlist, inherits unsafe helper config, or uses shell string interpolation.
4. No write to inspected repositories occurs unless the user explicitly opts a state directory into that location.
5. No generic filesystem write or read is exposed through MCP.
6. No secret-basename file is served even if it matches a context glob.
7. Every bounded output signals truncation or an explicit limit.
8. Every tool response includes provenance or structured state availability.

If any invariant would be violated by a proposed change, the change must be rejected or put behind a reviewed, opt-in flag.
