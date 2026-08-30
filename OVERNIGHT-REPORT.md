# Overnight hardening report — 2026-08-30

Branch: `overnight/hardening-20260830`, worktree `/Users/ty/dev/Context-Bridge-hardening`.
`main` untouched: still at `7c3da65`, with the same single uncommitted WIP in
`src/mcp/server.ts` it had at the start. Nothing pushed, merged, or published.

Scope was three items from `ROADMAP.md` §Next, in order, one commit per item.
All three are done and `npm run release:check` passes on the final state.

## Test counts

| Stage | Files | Tests |
|---|---|---|
| Baseline (`7c3da65`) | 13 | 125 |
| After item 1 | 15 | 151 |
| After item 2 | 16 | 163 |
| After item 3 | 17 | 177 |

All green at every stage. Final gate:

```
npm run release:check
  build + typecheck + lint clean
  Test Files 17 passed (17)
  Tests 177 passed (177)
  release package check: v0.4.0, 78 files, docs/links/binaries present
```

## Commits

| SHA | Commit |
|---|---|
| `829ded8` | `fix(security): resolve dangling symlinks and case-fold deny globs` |
| `12a1c10` | `test(security): fuzz path containment with adversarial fixture trees` |
| `6814b88` | `test(bounds): property-based truncation invariants, and fix three bounds` |
| `67ee83c` | `feat(mcp): expose includeIgnored and excludeGlobs as search args` |

Four commits for three items: the item-1 fixtures exposed two real containment
bugs, which landed as their own commit ahead of the fixture suite so the fix is
reviewable on its own.

## Item 1 — fuzz path containment with adversarial fixture trees

`src/__tests__/security-fuzz.test.ts` (17 tests). Synthetic trees per case under a
tempdir, following the `security.test.ts` patterns already in the repo (`mkdtemp`
helper, `try/finally` cleanup).

The suite asserts one invariant rather than exact outcomes: **a path the OS would
resolve outside every allowed root is never reported as inside one.** Throwing is
always acceptable — a `PolicyError` is an explicit refusal, and a raw errno
(`ENOTDIR` on a file used as a directory, `ELOOP` on a cycle) still denies access.
Only a *returned* escaping path fails. That framing stops the tests pinning
incidental error types as contract.

Classes covered:

- long symlink chains (8 and 12 hops), inside and escaping
- escape mid-chain that stays out; detour outside that lands back in (allowed —
  `realpath` is ground truth, not hop count)
- self-referential symlink cycles
- `..` applied to symlinked parents, swept over all 8⁴ = 4096 four-segment payload
  combinations of `["..", ".", "a", "b", "esc", "loot.txt", "", "//"]`
- case-insensitive filesystem edges: `.git`, `node_modules`, denied segments and
  secret basenames under mixed case, plus containment when a directory is reached
  under a different case
- NFC/NFD normalization collisions, gated on a runtime probe so the file behaves on
  both normalizing (APFS) and non-normalizing filesystems
- `.git` deny still applying to content reached through an in-project symlink,
  where containment legitimately passes

### Bug 1 (real, security) — dangling symlink reported as contained

`realpath` answers `ENOENT` both for a missing path component and for a symlink
whose target is missing. `realpathWithMissingTail` could not tell them apart, so it
took the `ENOENT` as "component missing", re-attached the link's own basename to its
parent's realpath, and returned a path **inside** the root. Containment passed.
Creating the target afterwards turns that stored canonical path into a read outside
the root.

Repro (pre-fix, `src/__tests__/security-regression.test.ts`):

```
root    = mkdtemp()
outside = mkdtemp()
symlink(outside + "/not-created-yet.txt", root + "/pending-link")
new SecurityPolicy([root]).canonicalizeAndCheck(root + "/pending-link")
  expected: throws /escapes allowed roots/
  actual:   resolved to "<root>/pending-link"
```

Fixed by `lstat`ing first: when the name exists and `realpath` still answers
`ENOENT` over a symlink, read the link and keep resolving from its target. Manual
hops capped at `MAX_SYMLINK_HOPS` (40) for links the kernel never gets to report
`ELOOP` on. Applied to both the async and sync resolvers.

### Bug 2 (real, security) — deny globs matched case-sensitively

`matchesAnyGlob` passed `nocase: false`, so `**/*secret*`, `**/*token*`,
`**/credentials`, `**/.npmrc` and `**/node_modules/**` missed every non-lowercase
spelling. On a case-insensitive filesystem (macOS default) `MY-SECRET.json` and
`my-secret.json` are the same file, so the uppercase spelling served exactly what
the lowercase one denied.

Repro (pre-fix):

```
isDeniedByPolicy("/tmp/project/my-secret.json", "/tmp/project").denied  -> true
isDeniedByPolicy("/tmp/project/MY-SECRET.json", "/tmp/project").denied  -> false
```

Also reachable end-to-end: `discoverContextDocuments` listed and
`readContextDocument` served `docs/MY-SECRET.md`. Fixed with `nocase: true` —
case-folding a deny list only ever denies more.

Evidence: `security-regression.test.ts` 5 failed / 4 passed pre-fix, 9 passed
post-fix. Both recorded in `THREAT_MODEL.md` §5.2 and §5.5; §5.2's stated
mitigation ("tail is appended lexically") was the mechanism that failed.

## Item 2 — property-based truncation invariants

`src/__tests__/truncation-properties.test.ts` (12 tests), `fast-check` added as a
devDependency — the only new dependency.

Justification: the bounds are universally quantified statements ("for any content
and any budget, the payload fits"), and the failures live at input shapes nobody
writes by hand. Generating and shrinking those is what a property runner does.
Test-only; `files` in `package.json` ships `dist/` and `docs/` only. fast-check has
no transitive dependencies and runs no install scripts.

Three real bound violations found, all in the same blind spot — multi-byte
characters at the cut:

1. **Document reads could exceed `maxBytes`.** The bounded read sliced the buffer at
   exactly `maxBytes` and decoded it; a split character becomes U+FFFD, which is
   three bytes. Shrunk counterexample: content `"🙂"`, `maxBytes` 1 → 3 bytes
   returned.
2. **git diffs had the identical defect**, under a comment claiming the re-encode
   avoided it (`"Avoid cutting in middle of multi-byte char by re-encoding"`) — it
   did not. Truncated diffs were also corrupted: the result was not a prefix of the
   real diff.
3. **Search previews reached 304 characters** against a documented cap of 300,
   because the `"… "` and `" …"` markers were appended after the 300-character slice
   instead of counted inside it.

1 and 2 now share `src/core/truncate.ts`, which cuts on a character boundary and
does not assume its input is well-formed — a bounded read can itself end
mid-character, and a file that is not valid UTF-8 must still respect the budget
after decoding. That guard has its own property over arbitrary byte buffers,
verified red without it.

Evidence: 3 provider properties failed pre-fix (documents after 2 tests, search
preview after 4, git diff after 31); 12 passed post-fix.

The two git-backed properties spawn two git processes per run, so they carry an
explicit 120s timeout at 20 runs. At 40 runs they exceeded vitest's 30s default
under full-suite parallelism — a timeout, not a bound violation.

## Item 3 — `includeIgnored` / `excludeGlobs` as MCP search args

`src/__tests__/search-flags.test.ts` (14 tests). Both flags default to today's
behavior, so a caller that sends neither gets exactly the results it got before.

**Scope note.** The roadmap described both flags as "already internal, just not
exposed as MCP args yet". That held for `excludeGlobs`, which `SearchOptions`
accepted but neither `ContextService.search` nor the MCP layer threaded through.
`includeIgnored` did not exist at any layer, so it is **defined** here rather than
merely wired: it drops the `DEFAULT_EXCLUDES` convenience filter (`dist/`, `build/`,
`.next/`, `coverage/`, `*.min.js`, `*.bundle.js`) and nothing else. That is the only
place the work exceeded a pure wiring change, and it is the reading that matches the
flag's name and the item's stated intent.

The flags cannot widen access. Secrets, `.env`, `.git`, `node_modules` and binaries
are denied inside the walk by `isDeniedByPolicy`, independently of this filter, and
`.git`/`node_modules` are additionally skipped by name before any glob is consulted.
A test asserts `includeIgnored: true` still returns none of them.

`context_search` now validates through Zod like the continuity tools rather than the
ad-hoc `requiredString`/`optionalInteger` helpers. The schema is `.strict()`,
matching the tool's existing `additionalProperties: false`. `excludeGlobs` is bounded
at 50 entries of 200 chars so a caller cannot hand minimatch an unbounded pattern set
to evaluate per walked file. `mkSchema` gained `items` support so the array property
emits well-formed JSON Schema.

Evidence: 9 failed / 5 passed pre-implementation — the 5 passing were the
baseline-preserving cases (default behavior unchanged, security invariant already
held); 14 passed post-implementation.

## Docs touched

- `THREAT_MODEL.md` §5.2, §5.5 — both containment bugs and the new resolver
  behavior; §5.2 test-coverage line now points at the fixture and regression suites.
- `DESIGN.md` §3.6 — byte budgets cut on character boundaries, marker outside the
  budget, preview cap stated as 300 including its ellipses; decision table row for
  the new search filter flags.
- `README.md` — `context_search` row mentions the two flags.
- `ROADMAP.md` — the three completed items removed from §Next.

## Left unverified / notes for review

- **Case-folding the deny globs is deliberately broader on case-sensitive
  filesystems.** On Linux, `MY-SECRET.json` and `my-secret.json` are distinct files
  and only the latter was denied before; both are denied now. This is intentional —
  over-denying a secret-shaped name is the safe direction — but it is a behavior
  change for Linux users who have a legitimately-named file matching `*secret*`,
  `*token*` or `*credential*` in mixed case.
- **The unicode-normalization fixtures are gated on a runtime probe.** On APFS they
  exercise NFC/NFD collision; on a non-normalizing filesystem they return early.
  They were only ever executed against macOS/APFS in this window, so the
  non-normalizing branch is untested in practice.
- **TOCTOU is out of reach for these fixtures.** Every case here is a static tree
  built before the check. A path swapped between `realpath` and the subsequent read
  is not deterministically testable without injecting a seam into the resolver, so
  no such test was written and no claim about TOCTOU resistance should be read into
  this suite.
- **`getBoundedDiff` swallows all git failures as `{ diff: null }`.** Unchanged by
  this work and out of scope, but it means a truncation property cannot distinguish
  "no diff" from "git errored"; the properties skip on `null` rather than asserting.
- No performance measurement was taken on the `nocase: true` change to
  `matchesAnyGlob`, which now runs case-insensitive minimatch per candidate file.
  The existing large-tree test (`does not overflow the stack or scan the whole tree
  on a huge project`) still passes well inside its budget, but this was not profiled.
