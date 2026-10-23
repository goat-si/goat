# Outside agents

Agents that GOAT did not start can work with an environment through its MCP
server. They can read projects and threads, start and message threads, and
check which providers and models are available. This covers Claude Code or
Codex in your own terminal, ChatGPT, and bots that support MCP. Each agent signs
in once, and you choose what it may do.

## Get the MCP URL

In **Settings → Connections**, open a saved environment's menu and choose
**Copy MCP URL**. The URL is the environment's address followed by `/mcp`, for
example:

```text
https://<environment-address>/mcp
```

The copied URL uses the route this device is connected over, so an agent on the
same device can reach it.

- **An agent on your own computers** can use `localhost` on the host or any
  `https` address, such as
  [Tailscale HTTPS](./remote-access.md#tailscale-https). Signing in sends the
  agent's credentials to the environment, and agents only do that over `https`
  or to `localhost`. A plain-`http` LAN or Tailscale address, like
  `http://100.x.y.z:3773`, lets an agent find the environment but not finish
  signing in.
- **A hosted agent**, such as ChatGPT or a bot running in the cloud, must reach
  the environment from the internet through an HTTPS address you manage. GOAT
  Connect is coming soon; GOAT does not currently provide a public address. A
  Tailscale address only works from your own tailnet.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page on the environment.
The page names the agent and where its access goes:

- For an agent on your computer, approval returns to a `localhost` address on
  the computer that opened the page.
- For a hosted agent, approval goes to that service, such as `chatgpt.com`.
  Anyone who runs that service gets the access.

Only approve a sign-in you just started. To approve, enter a pairing code from
**Settings → Connections** or from `goat auth pairing create` on the host. A
browser already signed in to the environment with permission to manage access
can approve without a code.

Then choose what the agent may do:

- **Read only** is the default. The agent can read projects and threads and see
  the available providers and models. It cannot change anything.
- **Supervised** through **Full access** also let it start, message and stop
  threads in every project. A thread it starts or steers cannot run with more
  permissions than the mode you chose.

## Claude Code

```sh
claude mcp add --transport http goat https://<environment-address>/mcp
claude mcp login goat
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `goat` as connected
once you approve.

## Codex

```sh
codex mcp add goat --url https://<environment-address>/mcp
codex mcp login goat
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `goat` with OAuth once you approve.

## ChatGPT

Add the environment as a custom MCP app in ChatGPT's apps settings:

1. Create a new app or plugin with a custom MCP server.
2. Set the server URL to `https://<environment-address>/mcp`, using your
   server's publicly reachable HTTPS address.
3. Choose **OAuth** for authentication. ChatGPT discovers the rest; you do not
   need a client ID or secret.
4. Create the app, then approve the sign-in page that opens.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect. Give
it the MCP URL and choose OAuth, and the agent finds the sign-in settings itself.
Agents without OAuth support can use a client token instead.

## Long-running orchestrators

A bot or script that drives GOAT for weeks, such as an orchestrator on another
machine, should use one client token instead of signing in for every call.
Create it on the host:

```sh
goat auth client create --name "Grok Bot" --runtime-mode-ceiling approval-required --token-only
```

Send the token as `Authorization: Bearer <token>` to the MCP URL. It lasts 90
days unless you pass `--ttl`. The `--runtime-mode-ceiling` works like the access
you choose on the sign-in page. Without it, the client gets **Supervised**.

Initialize MCP once and reuse the `mcp-session-id` header from that response
for later calls, including long `goat_thread_wait` polls. End the session with
an HTTP `DELETE` when the bot shuts down.

`goat auth client list` shows each token's name and when it was last used.
The same tokens appear in **Settings → Connections**. Revoke one there or with
`goat auth client revoke <session-id>`.

### Let an orchestrator answer approvals

By default only you can answer a thread's approval requests, such as running a
command in a **Supervised** thread. To let a trusted orchestrator answer them
too, add the approve scope when you create its token:

```sh
goat auth client create --name "Grok Bot" \
  --scope orchestration:read --scope orchestration:operate --scope orchestration:approve
```

The client can then list approvals with `goat_pending_request_list`, read them
with `goat_pending_request_read`, and answer with `goat_pending_request_respond`
and `decision` set to `accept` or `decline`. It can only answer approvals in
threads that run within its ceiling. Each answer records the client's name and
reason, and the approval shows who answered it. This also works for threads on
SSH hosts that the client reaches through this environment, once those hosts
run a GOAT version that supports it.

Agents running inside GOAT and clients that signed in through the sign-in page
never get this permission. To make approvals human-only again, revoke the token
and create one without `orchestration:approve`.

## Cloud agents from any machine

Claude Cloud, Cursor Cloud and Devin Cloud runs only need one environment that is signed in to
that service. An agent can call `goat_cloud_holders` to see which connected environments hold a
login, and `goat_cloud_launch` to start a run there. Add `dryRun: true` to see which environment
would run it. The environment needs a project for the repository, and the run starts from that
project's pushed branch. Launching needs **Full access**.

A bot that starts cloud runs on its own can show them in GOAT with `goat_cloud_run_register`:

```json
{
  "provider": "cursorCloud",
  "url": "https://cursor.com/agents/bc-…",
  "repo": "owner/name",
  "launchedBy": "Grok Bot",
  "notifyWebhook": true
}
```

The run appears in Fleet under its provider and in the thread list with "via Grok Bot". When an
environment signed in to the same account can see the run, GOAT follows it and reports when it
ends. Otherwise it keeps only the link and says so (`tracking: "link-only"`), and never posts `run.completed` for it. Devin Cloud sessions
started outside GOAT are always link-only. **Stop** on a registered run's thread only stops
following it: the run keeps going, and you cancel it from its page in the provider.
`goat_cloud_run_forget` removes a registered run from GOAT; the cloud run itself keeps going.

## Scripts on the host

On the machine that runs the environment, sign the terminal in once with
`goat login`, and `goat thread` then uses the same tools:

```sh
goat login
id=$(goat thread start . "Find why the tests are slow")
goat thread send "$id" "Now fix it" --wait
goat thread show "$id"
goat thread list
```

`.` means the project that contains the current folder; a project id also
works. A new thread uses the project's default model and permission mode, and
runs in the project folder unless you pass `--worktree <base-branch>`. `send`
never interrupts: a busy thread gets the message as its next turn. Pass `-` as
the message to read it from stdin.

`--wait` prints the agent's reply. It exits 1 when the run fails or stops, and
2 when the agent waits for an answer you give in the app. Add `--json` for a
result that always includes the thread id.

`goat login` stores a client session for this environment that lasts 30 days. It
appears under **Settings → Connections** as "goat CLI", and threads it starts or
changes run at most `approval-required` unless you pass `--access`. `goat whoami`
shows which credential the terminal uses, and `goat logout` revokes it. Inside a
GOAT thread whose agent has a GOAT credential in its environment, `goat` uses
that thread's own access instead, and `goat login`, `goat pair`, and the
`goat auth` commands that create credentials refuse to run.

## Remove an agent

Approved agents appear under **Settings → Connections** like other clients.
Revoke one there to cut off its access immediately. A sign-in lasts 30 days;
after that the agent asks you to approve it again.
