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
