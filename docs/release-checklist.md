# Launch checklist

Use this checklist before announcing a Consistorium release. A green local checkout is not enough;
the customer path ends with a clean-machine install and a real MCP call.

## Current launch blocker

- [ ] `npm view consistorium version` returns the intended public version. It returned `E404`
  during the 2026-08-23 readiness audit, so the npm package must be published and verified before
  the quickstart is announced as the primary installation path.

Publishing changes external state. Authenticate the intended npm owner, inspect the tarball, and
publish only as an explicit release action—never as an incidental documentation or repair step.

## Automated release gate

Run from a clean checkout:

```bash
npm ci
npm run release:check
npm audit --omit=dev
git diff --check
```

`npm run release:check` builds, typechecks, lints, tests, and inspects `npm pack --dry-run`. It
fails if package, lockfile, plugin, CLI, and MCP versions diverge or if the tarball omits required
binaries, skills, or setup guides.

CI must pass on:

- [ ] Ubuntu with Node.js 20 and 22
- [ ] macOS with Node.js 20 and 22
- [ ] packed tarball installed into a fresh global prefix
- [ ] real stdio initialization and tool listing from that installed CLI
- [ ] `--read-only` exposes observation tools and hides task/handoff writes

## Registry and repository release

- [ ] Confirm `package.json`, `package-lock.json`, `plugin.json`, CLI `VERSION`, and MCP
  `SERVER_VERSION` match.
- [ ] Inspect `npm pack --dry-run` for private, generated, or unnecessary files.
- [ ] Publish from the intended npm account with provenance/2FA required by the organization.
- [ ] In a new temporary prefix, run `npm install -g consistorium@<version>` from the registry—not
  from the checkout—and verify `consistorium version` and `consistorium doctor`.
- [ ] Create the GitHub release/tag and move the final changelog notes out of **Unreleased**.
- [ ] Confirm README and npm links resolve from the published package page.

## Fresh-user local test

- [ ] Give Prompt A from [agent-install.md](agent-install.md) to an agent with no prior
  Consistorium context.
- [ ] Confirm it preserves an existing MCP configuration and existing project allowlist.
- [ ] Confirm it never allowlists a home directory or parent development directory.
- [ ] Confirm `context_list_projects` and `context_project_briefing` work through the actual client.
- [ ] Uninstall and reinstall; confirm external task/handoff state survives.
- [ ] Test macOS and Linux. Test Windows before claiming ChatGPT tunnel support there.

## Fresh-user ChatGPT test

- [ ] Use a non-developer test user in the intended OpenAI organization/workspace.
- [ ] Give Prompt B from [agent-install.md](agent-install.md) to the installation agent.
- [ ] Confirm the agent asks the user only for unavoidable account approval/copy actions.
- [ ] Confirm the runtime key never appears in chat, terminal output, shell history, logs, config,
  screenshots, or the repository; confirm key file permissions are user-only.
- [ ] Confirm direct stdio `context_list_projects` works before adding the tunnel.
- [ ] Confirm managed runtime status is running, healthy, and ready.
- [ ] Refresh Corpus Connect and confirm its action list includes `context_list_projects`.
- [ ] Start a new chat, attach Corpus Connect explicitly, and return real project names from the
  tool call.
- [ ] Reboot the test machine and confirm the documented restart path is sufficient.
- [ ] Stop the runtime and use Prompt C to confirm the repair flow diagnoses the right layer without
  rotating credentials or recreating the app.

## Security and product claims

- [ ] Describe this release as a local-first CLI plus a private ChatGPT developer-mode connection.
- [ ] Do not market Secure MCP Tunnel as public Plugin Directory distribution. OpenAI's secure
  tunnel does not support public plugin submission; a public offering needs a hosted authenticated
  service and its own threat-model review.
- [ ] Keep ChatGPT on `consistorium serve --read-only`; verify the 16-tool read-only surface.
- [ ] Confirm the secret denylist, canonical allowlist containment, bounded outputs, and no-telemetry
  claims against tests and [THREAT_MODEL.md](../THREAT_MODEL.md).
- [ ] Review all examples for literal keys, broad allowlists, `--force`, anonymous public binding,
  and commands that could echo clipboard contents.

## Launch materials and support

- [ ] Replace the README demo-GIF placeholder with a sanitized fixture recording, or remove the
  placeholder before release.
- [ ] Record the happy path from `npm install -g` through the first real ChatGPT project list.
- [ ] Confirm [install.md](install.md), [chatgpt-setup.md](chatgpt-setup.md), and all three agent
  prompts match the current CLI and ChatGPT UI.
- [ ] Prepare one support response that asks for redacted status/doctor output and never asks for a
  key value.
- [ ] Assign an owner for npm install failures, tunnel authentication, ChatGPT metadata refresh,
  and repository-security reports during launch week.
