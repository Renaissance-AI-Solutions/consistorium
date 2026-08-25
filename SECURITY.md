# Security Policy

## Supported Versions

| Version | Supported          |
|---------|------------------------------------------------|
| 0.4.x   | :white_check_mark: active development          |
| < 0.4   | :x: superseded; upgrade for the launch release |

## Reporting a Vulnerability

**Do not open a public issue for a security vulnerability.**

Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository. That is the preferred channel and needs no public disclosure.

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (or proof-of-concept)
- Any relevant logs, but **redact secrets, tokens, and private repository contents**

We will acknowledge receipt within 72 hours and provide a timeline for a fix.

## Security Design

Consistorium's threat model and controls are documented in `THREAT_MODEL.md` and summarized in `README.md` and `DESIGN.md`. Key invariants:

- Repository/worktree observation is read-only; the only MCP writes are bounded structured task/handoff records
- Explicit workspace allowlisting with `realpath` canonicalization
- Denylisted secrets/credentials; bounded outputs; no shell interpolation
- Only allowlisted, hardened `git` subcommands via `execFile` arg arrays; helper/config/fsmonitor/textconv paths are disabled
- State records live under a mode-restricted directory outside configured projects by default; set `CONSISTORIUM_STATE_DIR` explicitly only when you understand the boundary
- Assertions in handoffs are never canonical Git truth; inspect `repositoryState.canonical`, `refreshed`, `staleness`, and `mismatches`

If you believe any invariant is violated, please report it as a vulnerability even if you are unsure of exploitability.

## Safe Usage

- Treat your Consistorium configuration (`~/.config/consistorium/config.yaml`; pre-0.4 installs may still use `~/.config/context-bridge/`) as sensitive: it lists project paths you consider safe to expose to MCP clients.
- Do not allowlist directories that contain secrets you do not want surfaced via context documents or search previews, even though denylists add a second defense layer.
- Review `context` globs before committing them to a shared/dotfiles repo — they control which files an MCP client can read.
- MCP clients run `dist/mcp/server.js` locally; ensure the client you use respects the plugin's declared roots and does not proxy Consistorium data to the network without consent.
- A fresh agent should call `context_list_projects` then `context_project_briefing`. Drill into `task_*` / `handoff_*` / `project_snapshot` only when the briefing is not enough.
- The Streamable HTTP listener binds 127.0.0.1 and requires `CONSISTORIUM_TOKEN` unless `--allow-anonymous` is set on loopback. Do not put an unauthenticated public URL in front of it.

## Disclosure

We follow coordinated disclosure. After a fix is available, we will publish an advisory describing affected versions, upgrade guidance, and crediting the reporter if desired.
