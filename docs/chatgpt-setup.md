# Connecting ChatGPT to Consistorium

ChatGPT does not launch a local stdio process — it reaches an MCP server over the network, and
supports **OAuth or no authentication only**. There is no API-key field, so a bearer token cannot
be supplied from the ChatGPT side. The supported private path is OpenAI's
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), which makes
the tunnel — not the public internet — the access boundary.

## 1. Start the local HTTP server

```bash
export CONTEXT_BRIDGE_CONFIG="$HOME/.config/context-bridge/config.yaml"
consistorium serve --http --port 8787 --allow-anonymous
```

```
[consistorium] Streamable HTTP on http://127.0.0.1:8787/mcp (bind=127.0.0.1 writes=off auth=anonymous-loopback)
```

`--allow-anonymous` is accepted **only** on a loopback bind; a non-loopback bind refuses to start
without a token. HTTP write tools stay disabled unless you pass `--allow-writes` — execution
agents should record tasks and handoffs over stdio instead. Verify before going further:

```bash
curl -sS http://127.0.0.1:8787/healthz
```

## 2. Create the tunnel and a runtime key

1. Create a tunnel in [Tunnels management](https://platform.openai.com/settings/organization/tunnels)
   and copy its `tunnel_...` ID.
2. Create a **runtime** key in [API keys](https://platform.openai.com/settings/organization/api-keys)
   with **Restricted** permissions and the **Tunnels: Read + Use** scope. `Read only` is not
   enough — the daemon needs `Use`. `Manage` is only for creating and deleting tunnels, and an
   admin key should never be given to a long-lived daemon.
3. Download [`tunnel-client`](https://github.com/openai/tunnel-client/releases/latest) for your
   platform and check it against the release's `SHA256SUMS.txt` before running it.

## 3. Point the tunnel at this server

```bash
tunnel-client init --sample sample_mcp_remote_no_auth --profile consistorium --tunnel-id tunnel_YOUR_ID --mcp-server-url http://127.0.0.1:8787/mcp
```

`sample_mcp_remote_no_auth` is the right sample: this server is reachable over HTTP and
intentionally advertises no OAuth/PRMD metadata, and that sample expects protected-resource
metadata to 404. The generated profile records `api_key: "env:CONTROL_PLANE_API_KEY"` — a
reference, never the key itself.

```bash
export CONTROL_PLANE_API_KEY="sk-..."
tunnel-client doctor --profile consistorium   # expect: RESULT pass
tunnel-client run --profile consistorium
```

## 4. Add the connector in ChatGPT

Keep the daemon running — ChatGPT needs it up both for connector discovery and for every later
tool call. In ChatGPT: **Settings → Apps → Advanced → Developer mode**, add a developer-mode app,
choose **Tunnel** under Connection, and select your tunnel. Then, in a new chat with
developer-mode tools enabled:

> What should we do next with corpus? Use Consistorium.

A grounded answer cites live git state and allowlisted documents, and separates them from
anything an agent recorded. If it answers without calling a tool, it is guessing.

## Public HTTPS is not the default

ChatGPT can also import a public `https://…/mcp` URL. Because it cannot attach an API key, that
endpoint is readable by anyone who learns the URL. This repository ships no public unauthenticated
server and no OAuth 2.1 authorization server. Do not put a generic tunnel (ngrok, Cloudflare) in
front of this process unless you accept that your allowlisted repository text becomes reachable to
whoever has the link.

## Troubleshooting

| Symptom | Check |
|---|---|
| ChatGPT cannot see the server | Developer mode on, `tunnel-client run` still in the foreground, tunnel selected in the connector |
| `doctor` fails `control_plane_api_key` | `CONTROL_PLANE_API_KEY` is unset in the shell running the daemon |
| Tunnel authenticates but no tools appear | Runtime key needs the **Tunnels: Read + Use** scope; `Read only` is not sufficient |
| `invalid tunnel ID` | Must be `tunnel_` followed by 32 lowercase hex characters |
| HTTP 401 from curl tests | Send `Authorization: Bearer $CONTEXT_BRIDGE_TOKEN`, or use `--allow-anonymous` on loopback |
| HTTP 421 | `Host` header does not match the loopback bind |

## Demo script

The fastest way to see the value, once connected, from a fresh ChatGPT conversation:

1. *"What changed in `<project>` today?"* — answers from live git observation, not memory.
2. *"What remains before release, and what should I ask my coding agent to do next?"* — answers
   from open tasks, handoffs, blockers, and allowlisted roadmap documents.
3. *"My agents are working in two worktrees — are their changes compatible?"* — worktree snapshots
   plus branch divergence via `context_compare`.
