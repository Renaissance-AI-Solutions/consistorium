# Roadmap

This roadmap separates **working now** from **designed for later**. Nothing listed under "Later" is claimed as shipped.

## Working now (v0.4)

- Agent Plugins v1.0 packaging: `plugin.json`, `mcp.json` (stdio), `skills/project-state/SKILL.md`
- Configuration: YAML/JSON, XDG + `PLUGIN_DATA` + `CONSISTORIUM_CONFIG` resolution, `consistorium init` (interactive + flags), `config show` / `config validate`
- Security: explicit allowlist, `realpath` canonicalization, `..` traversal denial, symlink escape prevention, exact `.git` deny rule, secret-file denylist, binary skip, bounded outputs, hardened allowlisted `execFile` git, explicit unavailable states, and external-worktree boundaries
- Providers: git (worktree discovery, dirty/staged/untracked, branch/HEAD/detached, ahead/behind, recent commits, diff stat, bounded diff, merge-base), documents (discovery + bounded read), search (bounded plain-text)
- Context plane: `ContextService` plus `ContinuityStore` behind a transport-agnostic facade
- Continuity: bounded durable task/handoff JSON outside configured repositories by default, atomic writes, restrictive permissions, runtime Zod validation, canonical-vs-asserted Git state, refresh/staleness reporting
- MCP: 18 tools over stdio and Streamable HTTP, including `project_briefing`, `task_*`, and `handoff_*`, named `context_*` so OpenAI-style function-name validation accepts them (pre-0.3 dotted names still dispatch)
- Discovery: pattern-directed document resolution — literal patterns stat directly, globs walk only their static prefix, with a scan budget so repositories with hundreds of thousands of files stay bounded
- Skill: `project-state` (project → briefing → task/handoff detail → direct verification)
- HTTP: loopback Streamable HTTP at `/mcp`, bearer token, read-only by default, Host-header check
- Tests: security, config, git, documents, search, sessions, MCP, continuity, briefing, HTTP auth, and Agent A/B + Streamable HTTP e2e on synthetic tmp fixtures
- Tooling/docs: ESLint 9 flat config, README, THREAT_MODEL, DESIGN, SECURITY, CONTRIBUTING, LICENSE, example config, and Hermes CLI setup

## Next (hardening, no scope creep)

- Property-based tests for truncation invariants
- Optional `includeIgnored` / `excludeGlobs` flags on search (already internal, just not exposed as MCP args yet)
- Per-project limit profiles beyond the current global bounded config
- Broader `plugin.json` / `mcp.json` schema validation inside `doctor`

## Later (designed, not committed)

### Public ChatGPT OAuth

- Streamable HTTP exists. Public internet use still needs OAuth 2.1 (CIMD/DCR) per current OpenAI plugin auth docs. Not required for Secure MCP Tunnel / loopback.

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

### Decision provenance and design lineage (named, not built)

Consistorium is positioned today as persistent memory for coding agents. The direction this section names is one level up: why the project became what it is — cross-agent continuity, handoff history, decision provenance, experiments, lessons, rejected approaches. This extends Consistorium's existing task/handoff records; it is not a rename or a pivot, and nothing here is built.

- **Decision Record:** the decision, the alternatives considered, why the rejected ones were rejected, evidence links, date, decider.
- **Experiment Record:** the hypothesis, the isolated branch, the benchmark, the retain/reject outcome — including failures.
- `DESIGN.md:172` (`session-to-content`, lessons-learned with aggressive redaction) already hints at this direction; this section names it.
- Records would live in the same local continuity store as tasks and handoffs, under the same security boundaries. Consistorium would record experiment outcomes and reference branches; it would not create branches, run benchmarks, or orchestrate the loop (see Not planned).
- **Disagreement / resolution history (additive 2026-08-30):** what objections were raised, and why the winning argument won. Downstream of Cursus challenger/arbiter records — Cursus is the gate; Consistorium keeps the why. Still named, not built.
- **Per-task model execution attribution (additive 2026-08-30):** preserve references to Cursus Execution Attribution records (model id ≠ agent/principal id). Consistorium records provenance; it does not route models. Still named, not built.
- **Governance-domain decision lineage (additive 2026-08-30, labeled 2026-08-31):** completes the federation-session amendment (`Cursus/cursus-strategy-2026-08-30-1.md`), not the Codex Cursus Loop packet. With Cursus GovernanceDomain (`ontology.md` v4 — configurable governance incl. contributed/federated agents), vote records, governance decisions, and their disagreement/resolution chains join the same named-not-built evidence classes ("why the winning proposal won"). Cursus remains the gate; Consistorium keeps the why. Still named, not built.
- **Rejection records carry change-conditions (additive 2026-08-31):** a rejected experiment/decision should record *what would change the decision*, so a future Inventarium scan can trigger reconsideration ("signal S changes condition Y — revisit"). This is the revisit trigger of the **Codex Cursus Loop** (`Cursus/codex-cursus-loop-2026-08-31.md`); loop-run records (discovery → hypothesis → experiment → evaluation → outcome) join the named-not-built evidence classes above. Still named, not built.
- **Organizational artifact causality envelope (additive 2026-09-04, named not built):** one Video Studio output → compact JSON of principals, modelbinding, capability bindings, evidence refs, approval ids, artifact hash (`Cursus/codex-cursus-loop-2026-09-04.md` E8). This is org causality, **not** a JFrog/SBOM clone and not a Cursus entity. Still named, not built.

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
