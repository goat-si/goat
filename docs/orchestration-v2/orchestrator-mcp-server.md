# Orchestrator MCP Server

## Purpose

GOAT exposes V2 orchestration through its app-owned MCP endpoint. A provider
agent can use this endpoint to:

- create an app-owned sub-agent on any supported provider instance;
- wait for or poll the sub-agent's durable result;
- cancel an active delegated task; and
- create one or more ordinary top-level GOAT threads;
- list a project's threads and incrementally read any thread;
- rename threads, regenerate titles, and link or unlink pull requests;
- send or steer follow-up messages; and
- wait for or interrupt ordinary thread runs.

These are GOAT orchestration operations, not provider-native sub-agent APIs.
Delegated tasks always create a GOAT child thread and run. The child receives
only the supplied task prompt, plus an optional role instruction supplied in
the same tool call. Parent conversation history is not copied into the child.

`ThreadManagementService` is the shared server application boundary for V2
WebSocket commands and MCP. It owns thread lookup, listing, send-mode
selection, durable send postconditions, wait polling, and interrupt selection;
`OrchestratorV2` remains the lower-level command/event processor. Transport
adapters only authenticate, resolve transport-specific inputs, and shape
responses.

## Transport And Authentication

The orchestration tools share the existing authenticated HTTP MCP endpoint:

```text
http://127.0.0.1:<server-port>/mcp
```

The provider-visible server key is `goat`. The endpoint registers both the
preview toolkit and the orchestration toolkit.

Before `ProviderSessionManager` opens a new V2 provider session, it asks
`McpSessionRegistry` for a credential scoped to:

- the GOAT environment;
- the parent GOAT thread;
- the concrete provider instance; and
- the provider session.

The credential grants `preview` and `orchestration` capabilities. The raw
token is not persisted in orchestration state.

A thread keeps one bearer token for as long as GOAT holds its attachment to a
provider instance. Provider processes keep the header they were given, for the
rest of a turn (Codex, ACP, OpenCode, Cursor) or for their whole life (Pi,
Muse), so a change in authority (memory policy, browser or device access,
read-only, task ceilings) replaces the record behind the same token and bumps
its `credentialGeneration`. Permits and memory admission taken under an older
generation are refused. When the committed memory policy moves before the
thread is re-prepared, the token keeps its other authority and loses only
memory. A new token is minted only for a different provider instance or after
revocation.

An idle credential expires after the liveness window unless the session it was
issued to is still attached, in which case the next call renews it. Releasing
the provider session revokes it, and a revoked credential is never renewed.
Local provider processes are scoped children of the server, so a restart or
update ends them and the next turn opens a new session with a new credential.
Tokens carry a per-run tag, which lets the server recognize one minted before
it restarted without persisting anything secret.

Every refusal is logged and traced as `McpHttpServer.refuseCredential` with its
reason (`expired`, `revoked`, `earlier_server`, `unknown`, `missing`) and,
when known, the thread and credential id. MCP clients replace a 401 with their
own text, so a refused `tools/call` carrying a registry-shaped token is answered
with an `isError` tool result that says what happened and that GOAT
re-authenticates the thread at its next turn. Other requests, and session
tokens that may sign in through OAuth, still get 401.

The MCP HTTP server resolves the bearer token and supplies the resulting
`McpInvocationScope` to tool handlers. Orchestration handlers additionally
check the `orchestration` capability before reading or mutating state.

## Provider Injection

### Codex V2

Codex app-server receives the remote MCP server through command-line config
overrides:

```text
-c mcp_servers.goat.url=http://127.0.0.1:<port>/mcp
-c mcp_servers.goat.bearer_token_env_var="GOAT_MCP_BEARER_TOKEN"
```

The provider-session token is placed in `GOAT_MCP_BEARER_TOKEN`. Both the
production Codex launcher and the injectable test launcher use the same
projection helper.

### Claude Agent SDK V2

Claude receives an HTTP MCP server in its query options:

```ts
{
  mcpServers: {
    "goat": {
      type: "http",
      url: "http://127.0.0.1:<port>/mcp",
      headers: {
        Authorization: "Bearer <provider-session-token>",
      },
    },
  },
  allowedTools: [
    // existing allowed tools
    "mcp__goat__*",
  ],
}
```

The adapter logs only whether MCP configuration exists; it does not log the
server headers or token.

### Cursor Agent SDK V2

Cursor receives the same authenticated HTTP MCP endpoint through the SDK's
`mcpServers` agent and send options. The adapter passes the authorization header
to the SDK but projects only redacted option metadata into protocol diagnostics.

### Grok ACP V2

Grok receives the authenticated HTTP MCP endpoint through the ACP
`session/new`, `session/load`, and `session/fork` `mcpServers` field. The shared
ACP adapter owns standard protocol behavior; the Grok flavor adds xAI extension
requests such as structured user questions.

ACP does not define native subagents or active steering. Grok therefore uses
orchestrator-owned child threads and implements steering through
cancel-and-restart. Its current driver also lacks `session/fork`, so app forks
use portable context transfer. These are orchestrator policies, not
provider-specific MCP tools.

### ACP Registry V2

The `acpRegistry` driver is the generic flavor of the same shared ACP adapter.
Each provider instance names an agent from the official ACP Registry. Settings
searches the registry through the connected server, then prepares a compatible
distribution before persisting the provider instance. Binary distributions use
a managed, versioned cache; declared checksums are verified when present.
Version-pinned `npx` packages install globally through `npm`; `uvx` packages use
`uv tool install`. ACP launches the resulting global command directly, so the
same command is available for terminal authentication. A local executable may
override the installed command without changing the registry-declared arguments
or environment.

Search, preparation, provider status, and session startup share one
server-scoped catalog service. This keeps platform selection and registry
validation identical across settings and runtime use. Catalog inspection never
starts an ACP process, probes models, or performs authentication. The managed
provider snapshot creates a disposable `session/new` through the normal provider
refresh lifecycle, using success as the authentication-readiness proof and
projecting advertised models into the snapshot. Terminal-only login remains a
manual operation on the connected server.

Capabilities such as session loading, session forking, models, modes, and MCP
transport are enabled only when the selected agent advertises them. Missing
features degrade through V2 policy: steering uses interrupt-and-restart,
forking uses portable context when native `session/fork` is unavailable, and
subagents use orchestrator-owned child threads. Registry agents do not receive
provider-specific extensions; those remain in flavors such as Grok.

### Pi V2

GOAT keeps a provider-session HTTP bridge even when Pi supports native MCP.
`mcp.json` entries override native registrations, and native MCP's default
60-second request timeout can interrupt long-running GOAT tools. The bridge owns
the injected endpoint and credential and forwards Pi's cancellation signal.

When a provider session credential exists, the adapter writes a GOAT-owned
extension into the server cache and spawns
`pi --mode rpc --extension <cache>/pi-goat-mcp-extension.ts` with:

```text
GOAT_MCP_URL=http://127.0.0.1:<port>/mcp
GOAT_MCP_BEARER_TOKEN=<provider-session-token>
```

The extension registers each tool once under `mcp__goat__`. The public and
normalized names coincide, so no hidden alias is registered. Existing saved
loadouts or tool selectors using `mcp__t3-code__` or `mcp__t3_code__` must be
updated to `mcp__goat__`; the old names remain readable in history but are not
registered for execution. On Pi 0.99+,
`orchestrator_capabilities`, `delegate_task`, and `task_status` remain directly
available; optional tools are discovered through Pi's builtin `tool_search`.
On older Pi or without builtin search, all tools remain directly available.
The bridge calls the original MCP tool name over HTTP. Follow-up requests send
`mcp-protocol-version: 2025-06-18`; Effect's MCP transport returns 400
without it. The first turn of a session also receives the shared GOAT
orchestration instructions.

Pi keeps ownership of native extension discovery. GOAT does not replace Pi's
`subagent` tool or reproduce Pi's package and project-trust loader. Durable
delegation goes through the namespaced GOAT MCP `delegate_task` tool and the
shared orchestration child-thread lifecycle. When Pi's example `subagent`
extension is installed, the adapter observes its documented `details.results`
shape and projects task cards with no child thread id. Unknown result shapes
remain ordinary dynamic tool output.

### Provider Support

A provider instance can run child tasks when its live `ProviderInstance`
exposes a V2 `orchestrationAdapter` — the same registration the orchestrator
resolves when a `delegated_task.request` executes. That covers Codex, Claude
Agent SDK, Cursor Agent SDK, Grok, generic registry agents over ACP, OpenCode,
OpenCode 2, Pi, Antigravity, and any future driver that builds an adapter.
Capability discovery still reports other registered provider instances, but
marks them unavailable for orchestration when no adapter resolves. This keeps
provider selection model-visible without allowing a request that cannot run.

## Tool Surface

The server exposes the following orchestration tools.

### `orchestrator_capabilities`

Returns:

- the inherited provider instance and model;
- the parent runtime and interaction modes;
- registered provider instances and advertised models;
- whether each provider can run a child task; and
- feature flags for polling, cancellation, and batch thread creation.

Unavailable providers include model-visible constraints such as missing V2
adapter support, disabled state, missing executable, or missing authentication.

The model list is short on purpose: catalogs such as OpenCode can hold hundreds
of models, and every call lands in the agent's context. Each provider lists
custom, favorite, and the caller's own models, plus all current (non-legacy)
models for Codex, Claude, Muse, and Grok, or the first 8 current models in the
user's model order for other providers. `omittedModels` counts the rest, and the
`search` input finds them, legacy models included. `delegate_task` still accepts
any catalog model.

### `delegate_task`

Creates a GOAT-owned delegated task and immediately dispatches the supplied task
prompt, in a local child thread or on an SSH host.

```ts
type DelegateTaskInput = {
  task: string;
  target?: {
    host?: string;
    providerInstanceId?: string;
    driverKind?: string;
    model?: string;
  };
  remote?: {
    cwd: string;
    workspace?:
      | { type: "cwd" }
      | { type: "worktree"; branch: string; baseRef?: string; startFromOrigin?: boolean }
      | { type: "existing_worktree"; worktreePath: string; branch?: string };
  };
  title?: string;
  role?: "implementation" | "research" | "review" | "design" | "test" | "general";
  mode?: "async" | "wait";
  timeoutMs?: number;
  clientRequestId?: string;
  runtimeMode?: "inherit" | "approval-required" | "auto-accept-edits" | "full-access";
  interactionMode?: "inherit" | "plan" | "default";
};
```

Provider, model, runtime mode, and interaction mode inherit from the parent
when omitted. A driver-only target inherits the parent's provider instance
when it can run child tasks, and otherwise selects an available instance of
that driver; an explicit `providerInstanceId` is honored exactly and fails
when unavailable. Selecting a different provider without a model uses that
provider's first advertised model.

A provider runs a runtime mode it does not offer as `approval-required`, so a
child would ask for approval on every command. `orchestrator_capabilities`
lists `runtimeModes` only for a provider that offers some of the modes, and
omits it for a provider that offers all of them. When the target lists
`runtimeModes`, an explicit `runtimeMode` outside that list is refused, and an
inherited mode steps down to the broadest mode the target offers.

A local async child outlives an interrupt or Stop of the parent's turn and still wakes
the parent when it finishes. A local `mode: "wait"` child stops with the turn whose
blocking call it answers, unless that wait already timed out. `task_cancel` stops
either kind.

Each delegated review round uses a new `delegate_task` call with the original brief,
prior findings, responses, and unresolved objections. Track each round by its own `taskId` and use
a distinct `clientRequestId` per round, stable across retries of that round.
`childThreadId` is backing storage, not a target for another review round through
`goat_thread_send`. Ordinary thread messaging remains available for user-requested
conversations; it does not reopen a completed task. There is no task-level follow-up
API for preserving the same reviewer session.

Delegation requires an active parent run owned by the MCP credential's
provider session. The request becomes the V2 command
`delegated_task.request`.

`mode: "async"` returns the current durable state immediately.
`mode: "wait"` waits for the task result, including nested work and completion follow-ups, or until
the timeout expires. A wait timeout does not cancel the child; the result sets
`waitTimedOut: true`, and the caller can continue with `task_status`. A pending blocking
question also ends the wait with `hasPendingQuestion: true` and `waitTimedOut: false`.
If `hasPendingQuestion`, pass `threadId=childThreadId` to `goat_pending_request_list`,
`goat_pending_request_read` (with `requestId`) and `goat_pending_request_respond`, or ask
the user; the task's completion still wakes this thread. A pending live approval for the
task's own unfinished work also ends the wait. Its identity appears in `pendingApproval`;
it grants no approval authority. Read the fresh full request in the child thread before
responding, since the durable record can outlive its provider callback. Async questions
do not end the wait.

```ts
type DelegateTaskResult = {
  taskId: string;
  host?: string;
  childThreadId: string | null;
  childRunId: string | null;
  childNodeId: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  workState: "working" | "waiting_for_children" | "result_available";
  hasPendingChildRuns: boolean;
  providerInstanceId: string;
  model: string | null;
  summary: string | null;
  resultContextTransferId: string | null;
  latestTerminalRunId: string | null;
  latestTerminalStatus: "completed" | "failed" | "cancelled" | "interrupted" | null;
  latestTerminalSummary: string | null;
  latestTerminalResultContextTransferId: string | null;
  hasPendingQuestion: boolean;
  pendingApproval: {
    requestId: string;
    kind: "command" | "file-read" | "file-change" | "mcp-elicitation" | "permission";
    runId: string;
  } | null;
  waitTimedOut: boolean;
};
```

#### Remote tasks

Set `target.host` to an alias from `goat_ssh_host_list` and provide `remote.cwd`.
`remote.workspace` selects the folder or a remote worktree. Remote delegation
requires a full-access caller and launches with the caller's runtime mode as its
ceiling. Keep the returned `taskId` for `task_status` and `task_cancel`; the
host-qualified thread belongs to the remote environment.

Remote results are summary-only: `resultContextTransferId` is null. Completion
still arrives through delegated completion delivery when the launched remote run
stops. A parent Stop or a wait-mode parent turn ending does not stop remote work;
parent Stop disposes its automatic delivery. Use `task_cancel` to request an
interrupt on the remote. It returns `cancel_requested` until that run stops,
while `task_status` continues to report the task's running state.

### `task_status`

Reads a delegated task from the parent thread's durable projection. A task ID
from another parent thread is rejected. `childRunId` identifies the original
run. `workState` distinguishes active work, a finished turn waiting for children,
and an available result. The task remains nonterminal until its known work
finishes. Its published `summary` and result transfer then remain stable across
later follow-ups. `hasPendingChildRuns` reports later queued or executing turns;
`latestTerminal*` exposes later executed, non-monitor results without replacing
the published task result. Remote tasks expose summary-only results; a pending
`cancel_requested` does not make them terminal.

### `task_cancel`

For local tasks, stops the child thread with the internal `thread.stop` command, then stops every
task the child delegated, and disposes automatic parent delivery. Like a user Stop,
`thread.stop` interrupts the running turn, holds queued turns, and ends pull request
watches. A nonterminal task with no interruptible run is rejected. A terminal task
returns its existing status, and its child thread still stops, including later
runs and watch wakes. Published task results remain available. It accepts an
optional cancellation reason. For remote tasks it requests an interrupt and
returns `cancel_requested` until the remote run stops; parent Stop does not send
that interrupt.

### `create_threads`

Creates between one and twenty ordinary top-level GOAT threads:

```ts
type CreateThreadsInput = {
  threads: Array<{
    prompt?: string;
    title?: string;
    target?: {
      providerInstanceId?: string;
      driverKind?: string;
      model?: string;
    };
    runtimeMode?: "inherit" | "approval-required" | "auto-accept-edits" | "full-access";
    interactionMode?: "inherit" | "plan" | "default";
  }>;
  clientRequestId?: string;
};
```

Each entry independently resolves provider, model, and modes. The new threads
inherit the parent's project, branch, and worktree path, but they have no
sub-agent lineage. Entries with a prompt immediately dispatch a run; entries
without a prompt remain idle.

### `goat_thread_launch`

Launches one ordinary top-level thread through the app's launch service. Use an
explicit `workspaceStrategy` to create a new worktree (`worktree` with `baseRef`),
attach an existing checkout (`existing_worktree` with `worktreePath`), or use the
project root (`root`, also the default). The thread is bound to that workspace
before the agent starts. Creating a worktree in the task prompt does not update
this binding.

Pass the task in `message`. Project, model, and modes inherit when omitted;
workspace does not. `scratch: true` launches without a project, in a folder of
its own under the environment's Scratch project. For stacked PRs, use the parent branch as `baseRef` with
`startFromOrigin: false`. The new thread may not run with broader runtime or
interaction modes than the caller. Launch has no retry key, so inspect existing threads after a failed or lost response before
launching again. `create_threads` remains the batch option for a shared checkout.

### SSH launches and reports

`goat_ssh_thread_launch` launches an ordinary thread on a host from
`goat_ssh_host_list`, using `cwd` and `workspace` on that machine. It accepts up
to eight pending attachments, uploads them to the remote before launch, and
binds them to the remote's first message. Use `delegate_task` with `target.host`
for child work owned by the calling thread.

The remote agent sends milestones or questions with `goat_origin_report`.
`reportDelivery: "wake"` wakes the origin for the latest `needs_input` in each
batch; earlier questions and other reports wait for its next turn. `next_turn`
queues all reports for that turn, and `notify_only` retains status without a
wake or prompt delivery. `goat_ssh_reports` reads the origin's bounded dispatch
status list. Run-end notifications are controlled separately by
`notifyOnCompletion` and the launch watch.

A thread launched on the same machine (`goat_thread_launch`, `delegate_task`) has
no origin binding. Its `goat_origin_report` goes to the launching thread instead,
found the way question escalation finds it: `needs_input` wakes the launcher and
other reports wait in its inbox for its next turn.

A thread launched this way may name a host its own machine cannot reach in
`goat_thread_send`. The origin then delivers that send as the launcher thread,
within the launcher's modes, and the remote agent gets `delivery: "relayed"`.
Only `goat_thread_send` relays, and only for ordinary launched threads.

### Completion webhook

The launch watch's reports can also be posted to an agent outside GOAT. Turn on
the `completionWebhook` server setting (`{ enabled, url, secret, allLaunches,
externalLaunches, targets }`, off by default) and opt in per launch. Nothing posts
for a launch that does not opt in. The webhook rides on the launch watch, so it needs
`notifyOnCompletion` left on. The launcher's server posts, also for SSH launches.

Several agents can share one server and each hear only the launches they
dispatched. Pass `notifyTarget` to `goat_thread_launch` or
`goat_ssh_thread_launch`:

- `{ name }` routes to `completionWebhook.targets.<name>` (`{ url, secret }`). The
  secret lives in the server secret store like every settings secret, and a
  settings patch merges targets per name, with `null` removing one.
- `{ url, secretRef? }` routes to an inline receiver. `secretRef` comes from
  `request_secret` in the calling thread; the launch consumes it and keeps the
  value in the secret store until the watch ends.
  Any agent that may launch can pick this URL, so it must resolve to public
  addresses only: loopback, private, link-local, CGNAT, and metadata addresses
  are refused, the check repeats before every post, and redirects are not
  followed. A receiver on this machine or its network needs a named target.

A launch with a target posts only there; the default `url` never sees it. An
unknown name, a non-http(s) url, a used or foreign `secretRef`, or webhooks
switched off refuse the launch before any thread is created. The target is saved
with the watch, so it survives a restart; a named target removed from settings
stops receiving. `notifyWebhook: true` without a target posts to the default
`url`, and `allLaunches: true` sends every watch without a target there too.

A launch from an MCP client outside any GOAT thread has no thread to wake. With
the webhook on, a `notifyTarget` or `notifyWebhook: true` on that launch, or
`externalLaunches: true` for every such launch, gives it a launcherless watch: its run end, questions, and
host outages are posted to the webhook only, and the launch returns
`watching: true`. Without either, nothing changes: the launch returns
`watching: false` and nothing is posted. The watch follows remote threads at the
runtime mode the client was approved for. The watch belongs to the client
session that launched: only that session sees it in `goat_thread_status`.
After its run is reported it waits: a later `goat_thread_send` from the same
session re-arms it, and that run is reported to the webhook too. Another client
sending to the thread does not. It ends without a report when the webhook stops
posting it (turned off, or the launch's settings no longer match) or seven days
after it was last armed.
`goat_thread_watch`, `goat_thread_unwatch`, and `goat_thread_watch_list` still need
a thread credential, so a client cannot list or stop these watches.

Each report is one JSON `POST` after the launcher's wake is queued, never
instead of it: `{ id, event, threadId, runId, requestId?, host, title, status,
summary, excerpt, prUrl?, launcherThreadId, at }`, where `event` is
`run.completed`, `question`, or `host.unavailable`, and `launcherThreadId` is
`null` for a launcherless watch. Headers carry
`x-goat-event`, `x-goat-delivery` (the stable `id`), and, with a secret,
`x-goat-signature: sha256=<hex HMAC-SHA256 of the body>`. Network errors, 408,
429, and 5xx retry with the launch watch backoff, up to six attempts; turning
the setting off stops retries. Delivery is best effort: a report still
retrying when the server stops is lost, and a crash right after a wake can
repeat a report, so receivers dedupe on `x-goat-delivery`.

### `goat_thread_list`

Lists durable thread shells in one project, newest first: `projectId` when
given, else the calling thread's project. Callers can filter by title, run
status, and whether app-owned sub-agent threads are included. Results are
bounded and offset-paginated. Deleted threads are never listed.

### `goat_thread_search`

Finds threads whose title or finished user or assistant messages contain a
keyword, one match per thread, newest first. It is read-only. With `host`,
`hosts`, or `allHosts` it reaches other machines and so needs the same caller
as `goat_thread_list` with a host. Calls without those fields and their
existing result fields keep working.

Each environment searches only itself: a host is asked for its own
`goat_thread_search` and pages by offset. A fan-out merges every
environment's next page and keeps one offset per environment in an opaque
cursor, so pages stay exact without a shared index. A host that fails is
reported in `unavailableHosts` and left out of later pages, which keeps
them newest first and lets the search end. A host running
an older GOAT refuses the new arguments, and the error says to update it.
Each environment considers at most its newest 1000 matching threads per call,
and only a window of each matched message leaves SQLite, which keeps responses
small on the shared connection. `truncated` reports a cut, so callers narrow
the filters.

### `goat_thread_read`

Reads the durable state, recent runs, and visible timeline of any thread in
the environment by thread ID. A deleted thread returns `thread_not_found`. The
default `messages` view returns user messages, assistant
messages, and proposed plans. The `activity` view also returns summarized tool,
reasoning, checkpoint, handoff, and runtime-request items. Large item text is
bounded and reports whether it was truncated. `afterPosition` and
`nextPosition` support incremental reads.

Thread and message results include required `createdBy` and `creationSource`
provenance. MCP-created threads and user-role messages use `createdBy: "agent"`
and `creationSource: "mcp"`; provider output uses `creationSource: "provider"`.
Actor and ingress are separate so agent-authored user-role messages remain
distinguishable from human-authored messages.

Agents mention another thread as `[title](t3-thread://v1/<threadId>)`. The
link carries only the id. Clients first resolve it in the message's environment,
then use a unique match in another enabled environment. Ambiguous matches stay
unresolved. Web and desktop show the resolved thread’s current title. Mobile
relabels local matches; cross-environment links can retain the written label.

List and read results report `snoozed` and `snoozedUntil`, and
`goat_thread_list` filters on `snoozed`. The server's `isSnoozed` follows the
client's `effectiveSnoozed`, so agents and the sidebar agree: a snoozed thread
wakes early only when it has a pending request or fails after snoozing. Completed
runs, background wakes, and delegated completions keep it snoozed.

### `goat_thread_update`

Updates metadata for the calling thread or any other thread in the environment.
The typed actions are `rename`, `regenerate_title`, `link_pull_request`, and
`unlink_pull_request`. A link input supplies the repository, number, and URL;
the server records the target thread's project ID. Branch and workspace changes
are outside this tool.

The result includes the command ID and durable event sequence together with the
resultant title, title-regeneration marker, and linked pull request. Reusing a
`clientRequestId` for the same action and thread replays the same command
receipt. Thread list and read results expose the linked pull request, and thread
detail also exposes an in-flight title regeneration.

### `goat_thread_send`

Sends a message to any ordinary or delegated thread in the environment:

- A message from an agent in another GOAT thread is delivered like steering in
  every mode except `restart`: it joins a running turn, waits for a starting
  turn and joins it as soon as the provider turn runs, or starts an idle thread.
  The wait inside the call is bounded (`STEER_READY_WAIT_MS`, below a client's
  tool-call timeout); past it the message is queued durably and the server still
  promotes it into the turn once it can steer. That promotion lives in the
  running server: after a restart the queued message runs as the next turn. A
  parent's follow-up to its own delegated child is not promoted either, because
  its queued run already owns a follow-up task; it runs after the child's turn.
  A provider that steers by interrupt-and-restart restarts the turn with the
  message, as its own steer does. A provider that can do neither, a turn in
  post-turn settlement, and `/compact`, `/logout` or `/goal` take it as the next
  turn. A turn the user stopped first fails the send.
- For a thread sending to itself and for clients outside GOAT threads, `auto`
  behaves as above, `queue` creates a separate follow-up run after active work,
  and `steer` requires a steerable active provider turn.
- `restart` requires an active provider turn and uses the orchestrator's
  interrupt-and-restart path.
- A send relayed to another host from a GOAT thread forwards `queue` and
  `steer` as `auto`, because the destination sees an outside client.

The target runtime and interaction modes may not be broader than the caller's.
Stable command and message IDs are derived from `clientRequestId` for
idempotent retries.

### `goat_thread_wait`

Waits for a selected run to become `completed`, `failed`, `cancelled`,
`interrupted`, or `rolled_back`. Without `runId`, it pins the latest run at call
time; an idle thread returns immediately. A timeout reports the latest durable
status and does not cancel work.

### `goat_thread_status`

Answers at once where a thread's current run is, without reading the timeline or
waiting. `phase` comes from the active run's status (else the latest run's) and
its pending request: a user question or auth refresh is `waiting_input`, a
provider approval is `waiting_approval`. `watch` is the caller's own launch
watch, so a dispatcher can check that the run it just sent will be reported.
With `host`, a host whose GOAT predates the tool is read with a one-item
`goat_thread_read` instead, which cannot name the request kind and reports
`waiting`.

`failure` explains a run that failed before its agent's first message: during
workspace preparation (Git fetch, worktree checkout, setup script) or when its
provider refused to start it. It carries the error class, the message, and for a
preparation the last lines of its redacted log. The launch watch sends the same
facts, with a suggested action, to the launching thread when such a run ends; for
a host whose GOAT predates `failure` it falls back to `lastError`.

### `goat_thread_interrupt`

Interrupts a selected active run through the normal V2 `run.interrupt` command.
Without `runId`, it selects the newest interruptible run. A terminal run is
returned unchanged, and a thread with no active provider turn returns
`no_active_run`.

### `goat_thread_retry`

Runs the workspace preparation of a failed run again, the same as Retry on the
failure in the thread. Only a run whose preparation failed qualifies
(`failure.canRetry`); any other failed run is refused with `invalid_request`,
and a new `goat_thread_send` is the way forward there. The launch watch reports
the retried run like the original.

## Delegated Task Lifecycle

The MCP server is a command ingress into V2. It does not call provider adapters
directly.

```text
provider model
  -> MCP tools/call delegate_task
  -> authenticated OrchestratorMcpService
  -> shared ThreadManagementService
  -> V2 delegated_task.request command
  -> child thread + child run
  -> parent app_owned subagent projection
  -> parent/child execution nodes
  -> consumed subagent_spawn context transfer
  -> normal provider effect and runtime ingestion
  -> child run reaches a terminal state
  -> parent subagent/node/turn item finalized
  -> consumed subagent_result context transfer
  -> wait result or later task_status result
```

The child thread has lineage relationship `subagent` and points back to the
parent node. The parent gets an `app_owned` sub-agent projection and a
sub-agent turn item so the existing debug UI can render progress.

Terminal provider events trigger finalization. The event stream first replays
persisted events and then follows live events, so finalization also runs after
a server restart. An existing `subagent_result` transfer makes finalization
idempotent.

Users rarely watch child threads, so a child question would otherwise go
unanswered. When a child opens a pending `user_input` request, the parent gets
a notification message telling it to answer with the pending request tools or
ask the user. The message says whether the child is blocked or, for a Codex
async question, still working. If the question is answered or dismissed before
the notification starts a turn, that queued turn is cancelled. Approvals are not
routed, because those tools cannot answer them.
A parent still blocked in a `delegate_task` wait gets the blocking question
through that wait instead.
If the provider cuts that wait short, a still-pending live question wakes the
parent when its launching run completes, fails, or waits for post-turn work.
Stopping or interrupting the parent prevents this catch-up.

A failed run exposes its provider error before any progress text. Successful
results use the latest assistant content from the final work turn.

## Policy And Idempotency

- A child runtime mode may stay equal to or become narrower than the parent
  mode. It may not escalate privileges.
- A child interaction mode may stay equal to or narrow from `default` to
  `plan`. It may not escalate from `plan` to `default`.
- Thread tools take any thread in the environment as a target. For a thread
  caller, list and search cover one project: its own unless `projectId` is given.
- A tool that changes another thread needs the calling thread's live run, and
  the target's runtime and interaction modes may not be broader than the
  caller's. This is the same privilege ceiling as child creation.
- Provider instances must be enabled, installed, available, authenticated, and
  backed by a V2 adapter.
- A requested model must be advertised by the selected provider when the
  provider publishes a model list.
- `clientRequestId` derives stable command, thread, and message IDs within the
  provider session. Retrying the same call returns the same durable work.
- Calls without `clientRequestId` receive a generated request key and create
  new work.

Expected denials use the typed `OrchestratorMcpFailure` result:

```text
capability_denied
parent_not_active
provider_unavailable
model_unavailable
runtime_mode_escalation_denied
interaction_mode_escalation_denied
task_not_found
task_not_cancellable
thread_not_found
run_not_found
thread_not_sendable
thread_not_interruptible
invalid_request
orchestration_error
```

## Code Ownership

- Shared schemas: `packages/contracts/src/orchestratorMcp.ts` and
  `packages/contracts/src/threadMetadataMcp.ts`
- MCP services: `apps/server/src/mcp/OrchestratorMcpService.ts` and the focused
  `apps/server/src/mcp/ThreadMetadataMcpService.ts`
- Tool definitions and handlers:
  `apps/server/src/mcp/toolkits/orchestrator/`
- HTTP registration and authentication:
  `apps/server/src/mcp/McpHttpServer.ts`
- Credential lifecycle: `apps/server/src/mcp/McpSessionRegistry.ts`
- Provider injection:
  `apps/server/src/orchestration-v2/ProviderSessionManager.ts` and V2 adapters
- Durable delegated-task command and finalization:
  `apps/server/src/orchestration-v2/Orchestrator.ts`

## Verification

The integration test uses the real MCP toolkit registration, V2 orchestrator,
SQL persistence, event ingestion, projections, and checkpoints. Only the
external provider adapters are deterministic test implementations.

Coverage includes:

- capability discovery;
- cross-provider delegated completion;
- prompt-only child context;
- parent and child lineage projections;
- spawn and result context transfers;
- async status polling;
- cancellation;
- batch ordinary-thread creation;
- thread listing and timeline reads, including another project's threads;
- ordinary-thread send, wait, steering, and interruption;
- inheritance and per-thread provider overrides; and
- idempotent retries.

Provider adapter tests separately verify Codex, Claude, Cursor, Grok, and ACP
Registry behavior and MCP injection. The provider-session manager test verifies
that credentials exist before an adapter opens and are revoked when it closes.
