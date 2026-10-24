// Generated from skills/goat-mcp/SKILL.md by apps/server/scripts/sync-mcp-client-skill.ts.
// Bundled so `goat mcp skill` works offline; mcpClientSkill.test.ts fails when they differ.
export const MCP_CLIENT_SKILL = `---
name: goat-mcp
description: Connect an MCP client (Claude Code, Claude Desktop, Codex CLI, Cursor, VS Code, OpenCode, Gemini CLI, ChatGPT, Grok, or any stdio or HTTP MCP client) to a GOAT environment's MCP server, verify it with goat_describe, and rotate or revoke its access. Use when asked to install, add, connect, or fix the GOAT MCP server.
---

# Connect an MCP client to GOAT

GOAT serves one MCP server per environment: the machine that runs \`goat\` or the GOAT desktop
app. Through it a client can read projects and threads, start and message threads, and find every
other capability with \`goat_describe\`. Follow the steps in order and stop at the first one that
fails; the troubleshooting table names the usual causes.

## Rules

- Never print, log, or paste a token into chat, a commit, or a shared config file. Keep it in an
  environment variable (this skill uses \`GOAT_MCP_TOKEN\`) or the client's secret prompt.
- Tokens are issued on the machine that runs the environment. If you are not on it, ask the user to
  run the command there and set the variable themselves.
- Inside a GOAT thread, \`goat auth client create\` refuses to run. A thread already has its own
  GOAT tools; this skill is for clients GOAT did not start.

## 1. Find the MCP URL

The URL is the environment's address followed by \`/mcp\`:

| Where the client runs                                      | URL                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Same machine as the environment                            | \`http://127.0.0.1:3773/mcp\` (3773 is the default port)                          |
| Another of your machines on a tailnet                      | \`https://<machine>.<tailnet>.ts.net/mcp\` (Tailscale HTTPS)                      |
| Another machine with SSH access to the host                | \`ssh -N -L 3773:127.0.0.1:3773 <user>@<host>\`, then \`http://127.0.0.1:3773/mcp\` |
| A hosted service (ChatGPT, the xAI API, Claude connectors) | A public \`https://\` address you manage                                          |

In the GOAT app, **Settings → Connections**, then the environment's menu, **Copy MCP URL** copies
the address this device uses. A hosted service calls GOAT from its own servers, so a \`localhost\`
or tailnet address does not work for it.

Check that the environment answers before configuring a client:

\`\`\`sh
export GOAT_MCP_URL="http://127.0.0.1:3773/mcp"
curl -fsS "\${GOAT_MCP_URL%/mcp}/llms.txt" | head -3
\`\`\`

## 2. Choose how the client signs in

- **OAuth sign-in** suits clients that support remote MCP OAuth (Claude Code, Codex, ChatGPT,
  Claude connectors, OpenCode). Add the server without a token; the client opens GOAT's sign-in
  page, and the user approves it with a pairing code from **Settings → Connections** or
  \`goat auth pairing create\`, choosing **Read only** or a permission mode. Sign-in needs
  \`https\` or \`localhost\`; a plain \`http\` LAN or tailnet address cannot finish it. A sign-in
  lasts 30 days.
- **A client token** suits everything else: clients without OAuth, bots, scripts, and long-running
  orchestrators. It is sent as \`Authorization: Bearer <token>\`.

Issue a client token on the environment's machine. The \`goat\` command comes from
\`curl -fsSL https://raw.githubusercontent.com/goat-si/goat-releases/main/install.sh | sh\`.

\`\`\`sh
export GOAT_MCP_TOKEN="$(goat auth client create --name "Cursor on laptop" --token-only)"
\`\`\`

- \`--name\` is the label shown in **Settings → Connections** and \`goat auth client list\`.
- The token lasts 90 days; \`--ttl 30d\` changes that.
- By default it may read and operate, and threads it starts or changes run at most
  \`approval-required\`. \`--runtime-mode-ceiling <mode>\` changes that limit.
- \`--scope orchestration:read\` alone makes it read-only.
  \`--scope orchestration:read --scope orchestration:operate --scope orchestration:approve\` also
  lets it answer approval requests; give that only to a trusted orchestrator.
- If the environment runs with a non-default \`--base-dir\`, pass the same one here.

Put the export where the client reads its environment: a shell profile, a secret manager, or the
client's own env block. A desktop app started from a dock or launcher does not see variables
exported in a terminal.

## 3. Configure the client

Replace \`<url>\` with the URL from step 1. Every entry uses streamable HTTP; GOAT does not serve
the older HTTP+SSE transport.

Each token entry below stores a reference to \`GOAT_MCP_TOKEN\`, which the client reads when it
starts, so the token itself stays out of the config file. Keep the single quotes where shown:
they stop the shell from expanding the reference while the server is added.

### Claude Code

\`\`\`sh
# OAuth
claude mcp add --transport http goat <url>
claude mcp login goat
# Client token
claude mcp add-json --scope user goat \\
  '{"type":"http","url":"<url>","headers":{"Authorization":"Bearer \${GOAT_MCP_TOKEN}"}}'
claude mcp list
\`\`\`

### Codex CLI

\`\`\`sh
# OAuth
codex mcp add goat --url <url>
codex mcp login goat
# Client token, read from the environment when Codex starts
codex mcp add goat --url <url> --bearer-token-env-var GOAT_MCP_TOKEN
codex mcp list
\`\`\`

The same entry in \`~/.codex/config.toml\`:

\`\`\`toml
[mcp_servers.goat]
url = "<url>"
bearer_token_env_var = "GOAT_MCP_TOKEN"
\`\`\`

### Cursor

\`~/.cursor/mcp.json\`, or \`.cursor/mcp.json\` in a project:

\`\`\`json
{
  "mcpServers": {
    "goat": {
      "url": "<url>",
      "headers": { "Authorization": "Bearer \${env:GOAT_MCP_TOKEN}" }
    }
  }
}
\`\`\`

### VS Code

\`.vscode/mcp.json\`, or the user \`mcp.json\`:

\`\`\`json
{
  "servers": {
    "goat": {
      "type": "http",
      "url": "<url>",
      "headers": { "Authorization": "Bearer \${env:GOAT_MCP_TOKEN}" }
    }
  }
}
\`\`\`

### OpenCode

\`opencode.json\`. \`oauth: false\` stops OpenCode from trying a sign-in first:

\`\`\`json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "goat": {
        "type": "remote",
        "url": "<url>",
        "oauth": false,
        "headers": { "Authorization": "Bearer {env:GOAT_MCP_TOKEN}" }
      }
    }
  }
}
\`\`\`

OpenCode V1 lists servers directly under \`mcp\` instead of \`mcp.servers\`. For OAuth, leave out
\`oauth\` and \`headers\` and sign in from \`/mcps\` in the TUI.

### Gemini CLI

\`\`\`sh
gemini mcp add --scope user --transport http \\
  --header 'Authorization: Bearer \${GOAT_MCP_TOKEN}' goat <url>
\`\`\`

Written by hand in \`~/.gemini/settings.json\`, the server needs \`httpUrl\`; Gemini treats \`url\`
as the old SSE transport.

### Claude Desktop

With a public \`https\` address, add GOAT under **Settings → Connectors → Add custom connector**
and sign in. Otherwise run the stdio bridge below from \`claude_desktop_config.json\` and restart
Claude Desktop.

### Clients that only start local stdio servers

\`mcp-remote\` (Node.js 20.18 or newer) turns the HTTP endpoint into a stdio server. Most stdio
clients take this shape, for example Claude Desktop's \`claude_desktop_config.json\`:

\`\`\`json
{
  "mcpServers": {
    "goat": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "<url>", "--header", "Authorization:\${GOAT_MCP_AUTH}"],
      "env": { "GOAT_MCP_AUTH": "Bearer <token>" }
    }
  }
}
\`\`\`

Keeping \`Bearer <token>\` in one variable avoids a space inside \`args\`, which some clients
split. A desktop app does not see variables from a terminal, so this \`env\` block holds the
token itself; keep the file private. For a plain \`http\` URL to anything other than
\`localhost\`, add \`--allow-http\`.

### ChatGPT

Add a custom MCP app in ChatGPT's settings with the public \`https://<address>/mcp\` URL and
**OAuth** authentication, then approve GOAT's sign-in page. ChatGPT needs no client ID or secret.

### Grok and other hosted APIs

The xAI API calls remote MCP servers from xAI's servers, so it needs a public \`https\` URL. Add
this to \`tools\` in a Responses API request:

\`\`\`json
{
  "type": "mcp",
  "server_url": "https://<address>/mcp",
  "server_label": "goat",
  "authorization": "Bearer <token>"
}
\`\`\`

Other bots and SDKs need the same three things: the URL, streamable HTTP, and the
\`Authorization\` header.

### Any other HTTP client or script

Send \`initialize\` with protocol version \`2025-06-18\` and
\`Accept: application/json, text/event-stream\`, then send every later request with the
\`mcp-session-id\` header from that response. End the session with an HTTP \`DELETE\` when done.

## 4. Verify

1. List the client's servers (\`claude mcp list\`, \`codex mcp list\`, Cursor's MCP settings) and
   check that \`goat\` is connected.
2. Call the \`goat_describe\` tool with no arguments. It lists GOAT's capability groups; run any of
   them with \`goat_call {path, args}\`, for example \`{"path": "project.list"}\`.
3. Without a client, check the token itself. A working token gets an index filtered for it:

\`\`\`sh
curl -fsS -H "Authorization: Bearer $GOAT_MCP_TOKEN" "\${GOAT_MCP_URL%/mcp}/llms.txt" | grep '^Filtered'
\`\`\`

It prints \`Filtered for this MCP client credential.\`; a rejected token gets a 401 instead.

## 5. Rotate or revoke

\`\`\`sh
goat auth client list                 # names, session ids and last use, never the tokens
goat auth client revoke <session-id>  # cuts the token off immediately
\`\`\`

To rotate, create a new token and update \`GOAT_MCP_TOKEN\` where the client reads it. Where a
config holds the token itself (the stdio bridge's \`env\` block, an xAI request), write the new
value there. Restart the client, verify, then revoke the old session id. Clients that signed in
with OAuth appear in **Settings → Connections**, where they can be revoked too.

## Remote and SSH hosts

Connect the client to one environment. Threads and projects on SSH hosts that the environment
manages are reached through it: capabilities marked \`host-routable\` in \`/llms.txt\` take a
\`host\` argument. A token belongs to the environment that issued it and does not work on another;
issue a separate token on each environment a client connects to directly.

## Troubleshooting

| Symptom                                                   | Cause and fix                                                                                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection refused or timeout                             | Wrong host or port, or the environment is not running. Run the \`curl\` from step 1 on the client's machine.                                                                                        |
| 401 on every request                                      | The token is missing, revoked, expired, or from another environment. The header must be exactly \`Authorization: Bearer <token>\`, and the client process must see the variable. Issue a new token. |
| Literal \`\${env:…}\`, \`{env:…}\` or \`\${GOAT_MCP_TOKEN}\` sent | The client started without the variable. Start it from a shell that exports it, or set it system-wide, then restart.                                                                              |
| Sign-in page cannot finish                                | The URL is plain \`http\` on a non-loopback address. Use Tailscale HTTPS, an SSH tunnel to \`127.0.0.1\`, or a client token.                                                                          |
| 404 or 405 while connecting, or an SSE error              | The client uses the old SSE transport (\`"type": "sse"\`, Gemini \`url\`), or the path does not end in \`/mcp\`. Switch to streamable HTTP, or bridge with \`mcp-remote\`.                                |
| 404 on every call after the environment restarted         | The client still sends its old \`mcp-session-id\`. Restart or reconnect the client so it initializes a new session.                                                                                 |
| Client reports an unsupported protocol version            | GOAT answers every \`initialize\` with MCP \`2025-06-18\`. Update the client, or bridge with \`mcp-remote\`.                                                                                            |
| Tools refuse to change anything                           | The grant is read-only. Issue a token with the default scopes, or approve the sign-in with a permission mode.                                                                                     |
| A hosted service cannot connect                           | It needs a public \`https\` address; \`localhost\` and tailnet names are private.                                                                                                                     |

\`goat mcp skill\` prints this guide on any machine with GOAT installed.
`;
