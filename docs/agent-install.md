# Install Consistorium with an AI agent

These prompts are for coding agents that can run commands on the user's computer. The agent should
complete the installation, configuration, client registration, and end-to-end test instead of
returning a tutorial.

Choose one prompt:

- [Local MCP client](#prompt-a-local-mcp-client) — Claude Code, Codex, Cursor, Windsurf, Hermes,
  or another client that can launch a local stdio server.
- [ChatGPT planning connection](#prompt-b-chatgpt-planning-connection) — Consistorium plus OpenAI's
  Secure MCP Tunnel and a ChatGPT developer-mode connection.
- [Repair an existing ChatGPT connection](#prompt-c-repair-an-existing-chatgpt-connection) — for an
  app that is visible in ChatGPT but does not call tools.

## What the user still has to do for ChatGPT

An agent can perform nearly all local setup. It cannot safely eliminate the account-security steps:

1. The user must be signed in to the intended OpenAI Platform organization and ChatGPT workspace.
2. The user must approve creation of a restricted runtime API key and copy the new secret once.
3. If the browser agent is not allowed to send a ChatGPT message, the user presses **Send** on the
   staged verification prompt.

The runtime key must never be pasted into an AI chat, issue, log, shell command, or documentation.
The `tunnel_...` tunnel ID is an identifier, not the secret. An OpenAI admin key is not needed for
the long-lived runtime.

Secure MCP Tunnel is a private, per-user developer-mode connection. OpenAI documents that it does
not support public plugin submission or distribution. A future public ChatGPT-directory version
would require a stable public HTTPS MCP service with per-user authentication; that is a separate
deployment architecture from this local-first product.

## Prompt A: local MCP client

Replace the bracketed values, then paste the whole prompt into the coding agent that owns the
repository.

```text
Install Consistorium end to end for this repository and connect it to your own MCP client.

Desired project:
- path: [USE THE CURRENT REPOSITORY, or put an absolute path here]
- project name: [SHORT PROJECT NAME]

Work autonomously. Do not stop after printing instructions when you can perform the next step.
Only ask me a question if the project path is ambiguous, an existing configuration would be
overwritten, or a required permission is unavailable.

Required outcome:
1. `consistorium` is installed as a normal global CLI.
2. The named project is the only new allowlisted root.
3. `consistorium doctor` passes.
4. Your MCP client is configured to launch `consistorium serve` with the resolved absolute config
   path in `CONSISTORIUM_CONFIG`.
5. You prove the connection by calling `context_list_projects` and
   `context_project_briefing` through the MCP client, not merely by invoking the CLI.

Procedure:
- Confirm Node.js is at least 20 and `git` is available. If not, explain the missing prerequisite
  and stop before changing anything.
- Install with `npm install -g consistorium`. If npm returns E404, install from the official
  `Renaissance-AI-Solutions/consistorium` repository: clone into a new dedicated directory, run
  `npm install`, `npm run build`, and `npm install -g .`. Do not treat `npm install` inside the
  checkout as a global CLI installation.
- Verify `consistorium version` and `consistorium --help`.
- Resolve the canonical project path. If the default Consistorium config already exists, inspect
  and preserve it. Add the requested project without removing existing entries. Back up a file
  immediately before editing it. Never use `--force` unless preserving the previous entries or I
  explicitly approve replacement.
- Use narrow default context-document globs. Do not allowlist my home directory, a parent dev
  directory, or any repository I did not name.
- Run `consistorium config validate`, `consistorium config show`, and `consistorium doctor`.
- Detect which MCP client you are running in and use its native registration mechanism. Use the
  absolute `consistorium` executable path if the client's environment may not inherit the shell
  PATH. Preserve unrelated MCP servers in its configuration.
- Restart or reload the client if your environment can do so safely. Otherwise give me only that
  one remaining action.
- Call `context_list_projects`, then `context_project_briefing` for the requested project. Report
  the returned project names and a short briefing as proof.

Safety boundaries:
- Do not modify files inside the allowlisted repository as part of installation.
- Do not expose or search secret-looking files.
- Treat MCP results as private repository data.
- Do not claim success from process health alone; the final proof is a real MCP tool call.

Finish with: installed version, config path, allowlisted roots, client config location, proof-call
result, and exact uninstall/repair commands.
```

## Prompt B: ChatGPT planning connection

This prompt assumes the coding agent has terminal access. Browser access lets it complete the
ChatGPT settings steps as well; otherwise the agent should reduce the remaining work to the two
account-security actions described above.

```text
Install Consistorium and connect it to ChatGPT as a private read-only planning source.

Desired project:
- path: [USE THE CURRENT REPOSITORY, or put an absolute path here]
- project name: [SHORT PROJECT NAME]
- ChatGPT app name: Project Context

Work autonomously and perform every safe step you have tools for. Do not return a generic setup
guide. Ask me only for an unavoidable account action, an ambiguous project path, or permission to
replace existing configuration.

Security rules that override convenience:
- Never ask me to paste an API key into chat.
- Never print, log, summarize, screenshot, or expose any key value.
- Never put a key literal in a shell command, command history, profile, YAML, or environment file.
- The required secret is a restricted OpenAI Platform runtime API key with Tunnels Read + Use.
  It is not the `tunnel_...` ID, a ChatGPT subscription credential, or an admin key.
- Reuse a valid existing key file and tunnel when possible. Do not rotate credentials merely as a
  troubleshooting guess.

Required outcome:
1. Consistorium is installed and `consistorium doctor` passes for only the approved roots.
2. The official OpenAI `tunnel-client` and its bundled companion are installed from the latest
   official release, with the downloaded archive verified against the release checksums.
3. The runtime key is stored outside the repository in a user-only file.
4. `tunnel-client runtimes connect` supervises `consistorium serve --read-only` over stdio.
5. Runtime status reports process_running=true, healthy=true, ready=true, and no remote error.
6. ChatGPT's Project Context metadata lists `context_list_projects` and the other read-only tools.
7. A new ChatGPT chat has Project Context attached and a real `context_list_projects` call returns
   the configured projects.

Procedure:
A. Install and verify Consistorium
- Check Node.js >= 20 and git.
- Run `npm install -g consistorium`. On npm E404 only, use the official source-install fallback:
  clone the repository, run `npm install`, `npm run build`, and `npm install -g .`.
- Preserve any existing config, add only the requested project, and use an absolute config path.
- Run `consistorium config validate`, `consistorium config show`, and `consistorium doctor`.
- Start a separate temporary stdio client and prove `context_list_projects` works before adding the
  network layer.

B. Install the official Secure MCP Tunnel client
- Follow current official OpenAI Secure MCP Tunnel documentation rather than an old blog post.
- Download the latest compatible `tunnel-client` release and its bundled companion from the
  official OpenAI release. Verify the archive using the published SHA256 checksums before
  installing both executables on PATH.
- Verify `tunnel-client --version` and `tunnel-client help quickstart`.

C. Obtain the two OpenAI values safely
- First inspect existing tunnel-client profiles and runtime aliases. Reuse the intended tunnel and
  key reference if `doctor` proves they work.
- If a tunnel is missing, use the OpenAI Platform Tunnels page to create or select one associated
  with the intended ChatGPT workspace and Platform organization. The tunnel ID is safe to show.
- If a runtime key is missing, open the OpenAI Platform API Keys page and prepare a Restricted key
  with only Tunnels Read + Use. If browser policy requires confirmation before creating persistent
  access, ask immediately before the final creation click. Tell me to copy the displayed key to my
  clipboard, never into this chat.
- After I say the key is copied, read it from the local clipboard without echoing it. Validate only
  that it is non-empty and has the expected OpenAI key prefix; do not display any portion of it.
  Write it with no trailing newline to the platform-appropriate equivalent of
  `~/.config/tunnel-client/runtime-key`; directory permissions must be user-only and file
  permissions must be owner-read/write only. Clear the clipboard and unset temporary variables.
  On macOS use `pbpaste`/`pbcopy`; on Linux use an available Wayland/X11 clipboard command; on
  Windows use PowerShell `Get-Clipboard` and an ACL restricted to the current user. If no safe
  clipboard reader exists, use a genuinely masked input prompt and verify that terminal echo is
  disabled before asking for the key.

D. Create one managed, read-only runtime
- Resolve absolute paths for both executables and the key file.
- Run the equivalent of:
  `tunnel-client runtimes connect --alias consistorium --profile consistorium-managed
  --tunnel-id <ID> --runtime-api-key file:<ABSOLUTE_KEY_PATH>
  --mcp-command "<ABSOLUTE_CONSISTORIUM_PATH> serve --read-only" --json`
- Do not start a separate Consistorium HTTP server. The preferred configuration is one managed
  tunnel-client process launching Consistorium over stdio.
- Run `tunnel-client runtimes status consistorium --json`. Do not claim success unless the process,
  health, readiness, and remote fields are all good. Run profile doctor with `--explain` on failure.

E. Refresh or create the ChatGPT connection
- Enable Developer mode in ChatGPT Settings -> Security and login if it is off.
- In ChatGPT Plugins, create the developer-mode app named Project Context using Connection: Tunnel
  and the selected tunnel. Review discovered actions before accepting it.
- If Project Context already exists, open Settings -> Plugins -> Project Context and select Refresh.
  This is required after tool names, schemas, annotations, or server metadata change.
- Confirm the refreshed action list contains `context_list_projects`. A visible plugin card alone
  is not proof that its tools are attached to a chat.
- Start a new ChatGPT conversation, open Add files and more, search for Project Context, and attach
  it. Send: `Use Project Context. Call context_list_projects and return the raw tool result.` If
  browser policy prevents sending on my behalf, stage the complete message and ask me only to press
  Send.

F. Prove and document the result
- Confirm the direct stdio call succeeded, the managed runtime is ready, ChatGPT performed an MCP
  initialize/tools call through the tunnel, and the ChatGPT answer contains the configured project.
- Leave these maintenance commands in the final report:
  `tunnel-client runtimes status consistorium`
  `tunnel-client runtimes stop consistorium`
  and the same `runtimes connect` command needed to start it again.
- Explain that the managed local runtime must be running for discovery and every ChatGPT tool call.
  Offer optional per-user startup automation separately; do not silently install a system service.
```

## Prompt C: repair an existing ChatGPT connection

Use this before deleting the app, rotating a key, or creating a new tunnel.

```text
Repair the existing Consistorium / Project Context ChatGPT connection using evidence at every layer.
Do not rotate credentials, delete the ChatGPT app, create a new tunnel, or expose raw MCP payloads
unless a specific diagnostic proves that action is necessary.

Check in this order:
1. Run `consistorium doctor` and make a direct temporary stdio MCP call to
   `context_list_projects`.
2. Run `tunnel-client runtimes status consistorium --json`; require process_running, healthy, and
   ready. If missing, inspect profiles/aliases and restart the existing managed runtime.
3. Run tunnel-client profile doctor with `--explain`. Distinguish runtime key auth failures from a
   wrong tunnel ID, missing workspace association, and a local MCP startup failure.
4. Inspect the loopback admin UI or redacted logs. Never enable raw unsafe HTTP logging against
   private repository data.
5. Confirm whether the ChatGPT attempt reached the tunnel by comparing initialize, tools/list, and
   tools/call counters before and after one test.
6. Open ChatGPT Settings -> Plugins -> Project Context. Confirm `context_list_projects` is listed,
   select Refresh, and wait for server discovery/tools listing to complete.
7. Start a new chat, explicitly attach Project Context from Add files and more, and call
   `context_list_projects`.

Interpretation:
- Direct stdio fails: fix Consistorium/config first.
- Direct stdio passes but runtime is not ready: fix tunnel-client/profile/key scope.
- Runtime receives no request: fix ChatGPT workspace association or chat attachment.
- Runtime returns calls successfully but ChatGPT says no tools are available: refresh plugin
  metadata, attach it to a new chat, and retest before changing credentials.

Finish with the identified failing layer, the single fix applied, and evidence from a real tool
result. Do not call a transport-level HTTP 200 proof of application success by itself.
```

## Planning-agent prompt for ChatGPT

After installation, users can paste this once at the start of a planning conversation:

```text
Use Project Context as the factual source for this planning session. Begin with
`context_list_projects`, then call `context_project_briefing` for the project I name. Treat
`live_observation` as current repository evidence and `agent_record` as a claim that may be stale.
Do not invent repository state and do not say the tool is unavailable until Project Context is
attached and you have attempted the call.

Act as the planning agent, not the coding agent. Clarify goals, identify constraints and blockers,
and produce a compact implementation handoff containing: objective, non-goals, acceptance tests,
likely files, risks, validation commands, and the first next action. When repository detail is
needed, use the narrowest Consistorium read tool. Do not request broad filesystem or terminal
access and do not modify code.
```

The coding agent can then start from that handoff, call `context_task_upsert`, implement and verify
the work, and finish with `context_handoff_create` so the next planning session sees the outcome.
