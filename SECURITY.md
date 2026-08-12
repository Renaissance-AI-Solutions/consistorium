# Security Policy

## Supported Versions

| Version | Supported          |
|---------|------------------------------------------------|
| 0.1.x   | :white_check_mark: active development          |

## Reporting a Vulnerability

**Do not open a public issue for a security vulnerability.**

Email the maintainers at the address listed in `plugin.json` / repository security advisories, or use GitHub's private vulnerability reporting flow if the repository is hosted on GitHub.

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (or proof-of-concept)
- Any relevant logs, but **redact secrets, tokens, and private repository contents**

We will acknowledge receipt within 72 hours and provide a timeline for a fix.

## Security Design

Context Bridge's threat model and controls are documented in `THREAT_MODEL.md` and summarized in `README.md` and `DESIGN.md`. Key invariants:

- Read-only by default; no repository or worktree mutation
- Explicit workspace allowlisting with `realpath` canonicalization
- Denylisted secrets/credentials; bounded outputs; no shell interpolation
- Only allowlisted `git` subcommands via `execFile` arg arrays

If you believe any invariant is violated, please report it as a vulnerability even if you are unsure of exploitability.

## Safe Usage

- Treat your `context-bridge` configuration (`~/.config/context-bridge/config.yaml`) as sensitive: it lists project paths you consider safe to expose to MCP clients.
- Do not allowlist directories that contain secrets you do not want surfaced via context documents or search previews, even though denylists add a second defense layer.
- Review `context` globs before committing them to a shared/dotfiles repo — they control which files an MCP client can read.
- MCP clients run `dist/mcp/server.js` locally; ensure the client you use respects the plugin's declared roots and does not proxy Context Bridge data to the network without consent.

## Disclosure

We follow coordinated disclosure. After a fix is available, we will publish an advisory describing affected versions, upgrade guidance, and crediting the reporter if desired.
