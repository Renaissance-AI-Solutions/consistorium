# Connecting ChatGPT to Consistorium

ChatGPT cannot launch a local MCP process directly. The supported private path is OpenAI's
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), which keeps
an outbound connection open from the user's computer without publishing a repository endpoint.

The recommended configuration lets `tunnel-client` launch and supervise
`consistorium serve --read-only` over stdio. There is no separate HTTP server to run, and ChatGPT
sees only the 16 observation tools; local coding clients can continue using the full 18-tool
surface when they need to record tasks and handoffs.

For a coding agent to perform the setup, give it **Prompt B** in
[agent-install.md](agent-install.md). The user should only need to approve a restricted runtime
key, copy it to the local clipboard, and—if browser policy requires it—press **Send** on a staged
verification message.

## Before starting: understand the two values

| Value | What it is | Secret? |
|---|---|---|
| `tunnel_...` ID | Identifies the selected Secure MCP Tunnel | No |
| Runtime API key | Authorizes the local tunnel runtime with **Tunnels: Read + Use** | **Yes** |

A ChatGPT subscription is not an API key, and the runtime does not need an OpenAI admin key. Never
paste the runtime key into an AI chat, issue, screenshot, shell command, or documentation.

## 1. Verify Consistorium locally

```bash
consistorium doctor
```

Do not continue until it lists the intended projects and every smoke briefing passes. The default
config is `~/.config/context-bridge/config.yaml`; initialize it first if needed.

## 2. Install the official tunnel client

Download the latest compatible archive from the official
[OpenAI tunnel-client releases](https://github.com/openai/tunnel-client/releases/latest). Verify
the archive against the release's published SHA256 checksums, then install both `tunnel-client`
and its bundled companion on `PATH`.

```bash
tunnel-client --version
tunnel-client help quickstart
```

## 3. Create or select the tunnel and runtime key

1. In [OpenAI Platform Tunnels](https://platform.openai.com/settings/organization/tunnels), create
   or select a tunnel for the same organization/workspace used in ChatGPT. Copy its `tunnel_...`
   ID.
2. In [OpenAI Platform API keys](https://platform.openai.com/settings/organization/api-keys),
   create a **Restricted** runtime key with **Tunnels: Read + Use**. Copy the new key once to the
   local clipboard—never into chat.

### Safe key-file handoff on macOS

With the key on the clipboard, run this exact block. It disables shell tracing, never prints the
key, writes it outside the repository, clears the clipboard, and removes the temporary variable:

```bash
set +x
install -d -m 700 "$HOME/.config/tunnel-client"
runtime_key="$(pbpaste)"
if [[ "$runtime_key" == sk-* ]]; then
  umask 077
  printf '%s' "$runtime_key" > "$HOME/.config/tunnel-client/runtime-key"
  chmod 600 "$HOME/.config/tunnel-client/runtime-key"
  printf '' | pbcopy
  unset runtime_key
  echo "Runtime key saved; clipboard cleared."
else
  unset runtime_key
  echo "Clipboard does not contain an OpenAI key; nothing was saved."
fi
```

On Linux or Windows, use Prompt B in [agent-install.md](agent-install.md); it tells the agent to use the
available clipboard API and owner-only file permissions without exposing the value.

## 4. Connect one managed, read-only runtime

Use absolute paths so the supervisor does not depend on the shell's startup files:

```bash
CONSISTORIUM_BIN="$(command -v consistorium)"
KEY_FILE="$HOME/.config/tunnel-client/runtime-key"

tunnel-client runtimes connect \
  --alias consistorium \
  --profile consistorium-managed \
  --tunnel-id tunnel_YOUR_ID \
  --runtime-api-key "file:$KEY_FILE" \
  --mcp-command "$CONSISTORIUM_BIN serve --read-only" \
  --json

tunnel-client runtimes status consistorium --json
```

Success requires `process_running`, `healthy`, and `ready` to be `true` with no remote error. The
managed runtime must remain running for ChatGPT discovery and every later tool call.

Useful maintenance commands:

```bash
tunnel-client runtimes status consistorium
tunnel-client runtimes stop consistorium
```

After a reboot, check status and repeat the `runtimes connect` command if needed. Per-user startup
automation is optional and should be installed only with the user's approval.

## 5. Create or refresh Corpus Connect in ChatGPT

Follow OpenAI's current [plugin connection flow](https://developers.openai.com/plugins/deploy/connect-chatgpt):

1. Enable **Developer mode** in **Settings → Security and login**.
2. In **ChatGPT Plugins**, create a developer app named **Corpus Connect**, choose **Tunnel** as
   the connection, and select the intended tunnel.
3. If Corpus Connect already exists, open **Settings → Plugins → Corpus Connect → Refresh**.
   Refresh whenever tool names, schemas, annotations, or server metadata change.
4. Confirm the action list includes `context_list_projects`. A visible plugin card alone does not
   attach its tools to a conversation.
5. Start a **new** chat. Open **Add files and more**, search for **Corpus Connect**, and attach it.
6. Send this exact verification prompt:

   > Use Corpus Connect. Call `context_list_projects` and return the raw tool result.

The connection is complete only when that ChatGPT tool call returns the configured project names.
An HTTP 200, a healthy process, or a visible app card by itself is not end-to-end proof.

## Planning-agent starter prompt

Once the verification passes, start planning sessions with:

```text
Use Corpus Connect as the factual source for this planning session. Call context_list_projects,
then context_project_briefing for the project I name. Treat live_observation as current repository
evidence and agent_record as a possibly stale claim. Act as the planning agent: clarify the goal,
identify constraints and blockers, and produce a coding-agent handoff with objective, non-goals,
acceptance tests, likely files, risks, validation commands, and the first next action. Do not modify
code and do not invent repository state.
```

## Troubleshooting by layer

| Symptom | Check |
|---|---|
| Direct local call fails | Run `consistorium doctor`; fix configuration before touching the tunnel |
| Corpus Connect is visible but tools are unavailable | Refresh it in Settings, then explicitly attach it to a new chat |
| Runtime is down or not ready | Run `tunnel-client runtimes status consistorium --json`, then reconnect the existing alias |
| Runtime key authentication fails | Confirm the key file exists with owner-only permissions and the key has **Tunnels: Read + Use**; do not rotate it as a first guess |
| Tunnel is healthy but receives no ChatGPT request | Confirm the Platform organization, ChatGPT workspace, selected tunnel, and per-chat attachment |
| Stdio process cannot start | Use the absolute Consistorium path and run `consistorium doctor` directly |
| HTTP 404/401 appears in an old setup | Stop using the two-process HTTP profile unless specifically needed; use managed stdio mode above |

For a full evidence-driven repair prompt, use **Prompt C** in
[agent-install.md](agent-install.md).

## Distribution boundary

Secure MCP Tunnel supports private developer-mode connections. OpenAI states that it does not
support public plugin submission or distribution. A public Plugin Directory offering would need a
stable hosted HTTPS MCP endpoint and per-user authentication; that is a separate product and
security architecture from Consistorium's local-first installation.

Do not put a generic public tunnel in front of Consistorium. This repository does not ship an OAuth
authorization server, and an unauthenticated public URL could expose allowlisted repository text.
