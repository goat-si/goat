# Channels and the GOAT bot

Input from the GOAT bot, Slack, and agents over MCP goes through one gateway into a ledger in
`statev2.sqlite`, separate from orchestration events. The ledger owns tasks, where their results go,
and who asked; coding threads own the work and its history. Code lives in
[`apps/server/src/channels/`](../../apps/server/src/channels/); the wire types are in
[`packages/contracts/src/channel*.ts`](../../packages/contracts/src/).

## The bot never runs a provider

The canonical bot thread holds messages and task chips written by the internal
`channel.timeline.record` command, all runless. A `message.dispatch` to the bot from a client is
turned into channel input in [`ThreadMessageIntake`](../../apps/server/src/orchestration-v2/ThreadMessageIntake.ts),
and the orchestrator refuses any other `message.dispatch` to it (MCP sends, schedules), so no path
starts a provider turn there. Replies come from a one-shot, tool-free text generation per input
(`generateChannelReception`; Codex and Claude only), not from a session that could queue behind
work. Chip notifications carry `ledgerTask`; only the ledger writes them.

An owner has one bot, in the Scratch project, and one bot conversation keyed by the owner rather
than the thread. If the bot thread is deleted, the next `ensureBot` starts a replacement and
records it in its place. The conversation, its open questions, and outstanding work carry over;
deliveries addressed to the old thread go to the current bot, and timeline ids include the thread
so a replayed record lands in the replacement without colliding with the old one.

## One home per cluster

A client connected to several GOAT servers would otherwise get one bot per server, and two servers
holding the same Slack app would both open its socket. The `goatBotHome` server setting names the
one environment the bot runs on. Clients write the same claim to every connected server that
advertises `capabilities.goatBotHome`, and a server whose claim names another environment refuses
`ensureBot` and GOAT and MCP front-desk input with `not_home`, closes input it had already stored
with a reply saying the bot moved, and keeps Slack closed. Worker reports and reads still work
there, and work started before a move finishes and reports where it started.

Claims only move forward. A claim is `{ environmentId, claimedAt, claimId }`, ordered by time and
then id, and a server keeps the larger of its claim and a written one, so a resync that arrives late
cannot undo a newer choice. A client that sees no claim picks a server, claims it, and calls
`ensureBot` only after the claim reads back as the winner; a client that sees servers disagree
rewrites the winner to them with backoff. There is no way back to "no home": a null without a time
would lose to any old claim still on an offline server. Changing the home is a new claim, timed
after every claim the client has seen so a client with a slow clock can still move it.

This is convergence, not a lock. A server that was offline keeps its old value until a client
connects to it, and two clients claiming at once can both see their own claim for a moment. The
guarantee covers settings RPC writes only: restoring an older `settings.json` by hand is taken as
the operator's choice and can make another server the home again until a client resyncs.

## Slack

The server layer assembles the live Slack runtime between the gateway and the workers
([`ChannelLayers`](../../apps/server/src/channels/ChannelLayers.ts)): the runtime needs the gateway
and transport registry, and the dispatcher reads the connection's default target. Release runs in
reverse, so Slack sockets close before the gateway and ledger. Shutdown does not drain envelopes:
one not yet stored was never acknowledged and Slack sends it again, and one stored but not
acknowledged comes back as a duplicate the inbox key absorbs. The desktop's short shutdown deadline
can cut a socket mid-close; that only changes which of those two happens.

A Slack connection's default target fills only what the task left open. The project named with the
work wins over the default project, which wins over the only project; the default model wins over
the project's (and, on another machine, the remote project's). A default project that no longer
exists becomes a question, never a different project. A default model this machine does not offer
is skipped with a warning and the project's model is used, because Slack settings have no control
to change the model; the model finally used must still be one the provider lists, or the requester
is asked. A provider that lists no models at all accepts any model, and the launch decides.
Defaults pick where and with what model; the requester's ceiling still bounds the rest.

On another machine the remote's only project stands in only when no project was asked for: a
project named here, or a default that is gone, must match one of its projects, or the requester is
asked. Dispatcher answers record their project resolution in the ledger. An answer that names
nothing can keep an earlier remote project choice only while its id still exists on the same
host. A newer project or machine choice replaces it; an answer that could not be resolved blocks
reuse of older choices. A retried generation starts without earlier choices.

## Who runs the workers

Background work (reception, dispatch, answer forwarding, wording task updates, delivery) runs in
the one process holding the worker row in `channel_runtime_state`. Ownership changes only by
compare-and-set on a stale heartbeat, and every worker write re-checks the token inside its
transaction, so a process that paused past the heartbeat cannot commit a claim. Any process can
accept input; the owner picks it up on its next pass.

## Restarts

Recovery reads state, not history. Every id a retry could recreate is derived from its natural
key (input from the idempotency key, worker launch from task and generation, deliveries from their
cause), so re-running a step lands on the same row, thread, or message. Task completion is decided
from the worker thread's current runs on each pass, so replayed or missed run events only change
timing. The delivery worker claims one outbox row right before sending it, so a restart finds at
most one row in flight. External deliveries left in flight become ambiguous rather than being sent
again; GOAT bot and MCP deliveries are retried because recording is idempotent. A task's later
delivery to a kind of destination waits until its earlier one there is delivered or given up, so a
receipt that hit a rate limit still arrives before the result.

## Agents over MCP

All MCP callers share the `mcp` connection, so the gateway scopes an agent's conversation key and
retry key by its request namespace: two agents that send the same `clientRequestId` stay two
inputs in two conversations. Agents cannot start work. Their replies are not pushed anywhere; the
outbox marks them delivered and the agent reads them with `channel_input_get`, which shows only
inputs from the caller's own namespace.

## Workers on other machines

A task can name another machine (`ChannelTask.host`, an SSH alias from this machine's SSH
config). The dispatcher then picks one of that machine's existing GOAT projects and starts the
worker there through [`SshRemoteDispatch`](../../apps/server/src/sshRemote/SshRemoteDispatch.ts),
the path `goat_ssh_thread_launch` uses, with an origin report binding. The remote server is not
changed: the worker files `goat_origin_report` there, and
[`ChannelRemoteWorkers`](../../apps/server/src/channels/ChannelRemoteWorkers.ts) long-polls
`goat_origin_reports_wait` and turns reports and the remote run's end into ledger events.

- **One thread per generation.** The binding id derives from the task and its generation, and the
  remote stores it before it creates the thread and refuses a duplicate. A launch whose answer was
  lost is looked up by that id before anything is launched again, so a relaunch cannot start a
  second remote thread. A retry is a new generation with a new binding; the old one is never read.
- **Reports land locally first.** Each wait answer is copied into the task's
  `remote-worker:<taskId>` row in `channel_runtime_state` together with the cursor, because the
  remote deletes reports up to the cursor and caps what it keeps. Each report then becomes at most
  one event, with an id derived from the binding and sequence.
- **Answers.** An answer goes to the remote thread with `goat_thread_send`. Until the remote shows
  the run that answer started, every report waits, so a late question from the earlier run cannot
  reopen the task. Delivery is at least once: a resend after the SSH session was reissued can repeat.
- **Permissions.** Only requesters who may start work at all (`orchestration:operate`) create
  tasks. The remote session's ceiling is the requester's runtime-mode ceiling, and the thread's
  mode is lowered to it; interaction mode and granular grants are not carried over. This is why the
  channel path does not need `goat_ssh_thread_launch`'s full-access caller: the dispatcher chooses
  the host and folder from validated lists, not an agent.
- **Models are checked there first.** The SSH launch does not say why a remote refused, so the
  dispatcher reads that machine's `orchestrator_capabilities` before launching. A Slack
  connection's model is only a preference: if that machine does not offer it, or cannot list its
  models, the remote project's model (or this machine's default) runs the work. If the model to
  run is listed as missing, the requester is asked to pick one for the project there. If the
  machine cannot be reached for the list, the requester is asked as for any unreachable machine.
  A machine that answers but cannot list its models (an older GOAT) is left to the launch, which
  fails the task if it refuses.
- **Completion is weaker than on this machine.** The remote does not report provider background
  work or a restart continuation that has not started a run
  ([#46](https://github.com/goat-si/goat/issues/46)). A finished run settles the task only after a
  second look ten seconds later finds no newer run or report; anything after that is not reported.
- **Reconnects.** An unreachable machine is retried with backoff; the requester hears once that it
  is unreachable and once when it is back, and the work keeps running there.
- **One destination per generation.** Once a launch was attempted, changing the task's machine
  (including back to this one) fails it as uncertain; a retry starts a new generation. Before any
  attempt the destination may change freely. Choosing an existing remote project is best effort:
  if it is deleted between the check and the launch, the remote may register the folder again.
- **Bounded inbox.** The local inbox keeps at most 200 reports; past that it drops progress first,
  then the oldest, and records how many were dropped as task progress.
- **Refused answers.** If the remote refuses an answer because the worker thread now runs above
  the requester's ceiling, the question is asked again with the answer quoted, as on this machine.
