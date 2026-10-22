# Channels and the GOAT bot

Input from the GOAT bot, Slack, local Mac iMessage, and agents over MCP goes through one gateway into a ledger in
`statev2.sqlite`, separate from orchestration events. The ledger owns tasks, where their results go,
and who asked; coding threads own the work and its history. Code lives in
[`apps/server/src/channels/`](../../apps/server/src/channels/); the wire types are in
[`packages/contracts/src/channel*.ts`](../../packages/contracts/src/).
What the bot must do for a person, and how it compares with other chat bots, is in
[goat-bot-behavior-spec.md](goat-bot-behavior-spec.md).

## The bot never runs a provider

The canonical bot thread holds messages and task chips written by the internal
`channel.timeline.record` command, all runless. A `message.dispatch` to the bot from a client is
turned into channel input in [`ThreadMessageIntake`](../../apps/server/src/orchestration-v2/ThreadMessageIntake.ts),
and the orchestrator refuses any other `message.dispatch` to it (MCP sends, schedules), so no path
starts a provider turn there. Replies come from a one-shot, tool-free text generation per input
(`generateChannelReception`; Codex and Claude only), not from a session that could queue behind
work. Chip notifications carry `ledgerTask`; only the ledger writes them.

## What the bot remembers and reads

Questions about past work and memory are answered in reception, without starting a worker,
because a coding thread costs a minute and a provider session for something the ledger already
knows. The model still runs no tools: a pass may answer with a `read` action naming up to three
lookups, the server runs them (each within five seconds), and one more pass answers with the
results. A second request to read is answered with what that pass wrote, so an input costs at most
two generations. Reads change nothing, so a reception retried after a crash reads again.

- **Memory.** Every pass gets the newest 6,000 characters of `goat-bot/memory.md` (standing
  notes, written only when the person's own message asks, as before) and a journal: one line per
  recent task, with its state, result and pull requests. The journal is built from the ledger for
  each requester rather than kept in a file, so it shows only work that requester may see, and it
  cannot drift from the ledger or lose a line in a crash. A `memory` read searches the notes, the
  requester's whole journal, and GOAT memory (`MemoryService.search`, the store agents use).
  GOAT memory is read under the requester's `memory:read` as it stands at read time: a Slack or
  iMessage link is read again on every permit check, and agents over MCP use their own memory
  tools instead. Reception writes GOAT memory only through the coding threads it starts, which get
  the requester's memory ceiling.
- **Work.** A `work` read matches the owner's 200 most recently updated tasks by task id, a
  linked pull request (by repository and number when the question names a repository), or shared
  words, and returns each task's request, result, machine, open questions and pull requests with
  their last known state. A `thread` read adds the last six messages from the newest runs of the
  task's coding thread on this machine; a thread on another machine is read through the reports
  already copied into the ledger, never over SSH during reception. A `conversation` read searches
  the text of older inputs and replies in the same conversation.
- **Who sees what.** Everyone sees the work of the conversation they write in. A person also sees
  work they asked for elsewhere, and all of the owner's work when they hold `orchestration:read`.
  Agents over MCP see only their own conversation. A Slack or iMessage link acts as the GOAT
  principal who made the link code, so it sees what that principal sees, judged with the link as
  it stands when reception reads: a link removed or narrowed after the message arrived leaves
  only that conversation's work. Read results and journal
  lines are labelled as records for the model, but the filtering above is what keeps them private.

## The bot's own turns

Some messages need tools but no repository change: why a disk is full, what three threads
concluded, a web search. Reception answers those with `run_turn`: it acknowledges at once, and a
ledger task of kind `turn` runs as an ordinary coding thread in the bot's own workspace on this
machine. Reusing the task path keeps every guarantee the ledger already gives work: one launch per
generation, the chip, exactly-once narration, restarts that read state, and the requester's
ceiling. Running a provider session on the bot thread itself would put each new message behind
the running turn and give the bot thread runs it was built never to have.

- **Model.** A turn runs on `goatBotModelSelection` from the home server's settings. Null follows
  the bot workspace's new-thread default, then the text generation model; a chosen model this
  machine no longer offers falls back with a warning, because the person asked a question, not
  for a model. Reception itself stays on the text generation model so the acknowledgement is fast.
- **Access.** A turn runs at the requester's ceiling, which is `full-access` for the owner. The
  default runtime mode does not narrow it: that setting is for people's new threads, and a
  sandbox below full access stalled the bot on approvals for ordinary reads outside its folder.
  The bot thread itself is `full-access` too, and `ChannelBotRegistry.ensure` switches a bot made
  under the old `approval-required` mode in place. Read-only is therefore a promise of the prompt
  alone: `GOAT_BOT_READ_ONLY_RULE` in `ChannelDispatcher.ts` is the one place it is stated, and
  nothing in the sandbox backs it. A requester linked below full access keeps their ceiling, so
  the bot never gives a person more than they could run themselves. Work that changes things is
  a coding task.
- **Computer use.** Full access does not reach the screen. Bot turns, channel task workers (known
  by their `channel-worker:` thread id, so before the ledger binds them) and every thread they
  launch or message count as unattended (`apps/server/src/cua/ComputerUseOrigin.ts`),
  so they get no `cua-driver` until a person approves a `computer_use.grant` handoff in a GOAT
  client session holding `settings:write`. Channel text never answers it: handoffs resolve only
  through authenticated client RPC. See ADR-0020.
- **Answer.** The turn's final report is the bot's reply, delivered as written; it is not
  reworded by reception the way coding results are, because the turn already wrote it for the
  person on the chosen model.
- **Follow-ups.** A message that adds to running work in its conversation (`follow_up`, or
  `run_turn` while a turn runs there) joins that work instead of starting more, if the sender, as
  their link stands now, may answer for its requester. Reception records a `task.followup.received`
  event in the same commit as its reply, with a completion fence (`pendingAnswerMessageId`) and a
  pending forward. The dispatcher's forward loop sends it with ids derived from the input: into
  the running run when it can take steering, else as the thread's next run. It then binds the
  task to whichever run took it and lifts the fence in one write. A crash before or after the send
  replays the forward onto the same message, and a run that ended just before the follow-up
  cannot settle the task, because the fence holds it until the follow-up's run is bound. This is
  the path answers to worker questions already take. Other conversations, and messages the bot
  answers directly, never wait on running work.

## Work items, worker runs, and stopping

A worker blocked on a person counts the same whether it or one of its subagents asked. Worker
reconciliation reads the pending requests of the live subagents a worker started, and of theirs,
up to three levels and twenty threads, and adds them to the task's `observed.needsYou`, so the
chip, the waiting count and "what's pending" show a subagent's approval as the work waiting on
the person. A subagent running in GOAT on another machine has no thread here; reconciliation
reads the needs-you list that machine last reported for the dispatch, without opening SSH, and
the approval names that machine. Subagents on another service, with no GOAT child thread and no
remote dispatch, are not read.

A local approval also names its request and thread (`needsYou[].approval`), and the observation
that first lists it narrates one approve/deny card to the work's origin conversation, keyed by the
request id so a later pass never sends it twice. The open cards are exactly the approvals the
task's observation lists, so an approval answered in its thread disappears on the next pass with
no card state to clean up. A reply that starts with an approve or deny word (English or Korean,
short messages only) is matched to a card before the reception model runs: an approval must not
depend on how a model read a message. A bare word answers the only open card; with several open
it asks which. Otherwise only the card's code picks one, never words from a task title: "approve
the PR" must not approve whatever command that task waits on. The ledger issues codes per
conversation in order (`A1`, `A2`, …, in `channel_runtime_state`) and never reuses one, so a
code, and an old card's button, names one request for good; a hash would let a stale button
collide with a newer request. A code whose request is no longer open says it was already
answered. Open cards come from every running task in the conversation that needs a person, past
the recent-task window reception otherwise reads. The answer is a
`runtime-request.respond` on this machine, with a command id derived from the input so a reception
rerun after a restart cannot answer twice, or `goat_pending_request_respond` on the machine the
approval names. The remote request resolves once, so a repeated answer fails closed. Both name the
person and channel for the thread's audit. The person must pass `mayAnswerFor` against the work's
requester as their link stands now. The remote call uses that person's runtime-mode ceiling and
asks for approvals; if that machine cannot grant them, the person is told and nothing is sent with
fewer permissions. MCP requesters get no cards, since agents never answer approvals.

A task is a work item: what a person asked for. Its worker runs are separate records, one per
run of the task's worker thread, kept as `worker-run:<task>:<run>` rows in
`channel_runtime_state` (a `ChannelWorkerRun`) rather than a new table, so no migration
competes with other work for an id. Worker reconciliation writes a run's row when its state
changes: running, waiting (on a person), stalled (no progress for 20 minutes), finished, failed
or stopped. A run finishing never finishes its item. The item's state comes from the task and
from its newest outcome delivery to where the work came from (`channelWorkQueue.ts`): finished
work stays open as "result not sent yet" or "result not delivered" until that delivery is
recorded delivered. Workers on other machines report through their host, so their runs are not
recorded here.

- **What's pending.** A `pending` read lists the open items the requester may see, newest
  first, with their runs, open questions and age; every open task is read, however old,
  including finished ones whose outcome has not reached the person. An item's
  outcome delivery is the narration of its newest terminal event, so a retried task is not
  closed by its earlier delivery. Runs still recorded as running after their item ended keep being
  reconciled until they end, and a task that ended within the last hour has its thread's runs
  read into history even if none were recorded while it ran.
- **At most four at once.** The dispatcher leaves a person's fifth item received while four of
  their items hold a worker: dispatching, running, or waiting on them with a worker. Stopped items
  keep their slot until their stop has gone through. Questions asked before any worker exists
  hold none. Remote dispatches handed off but not yet claimed are
  reserved in the dispatcher so they count too. The runtime dispatches received tasks oldest
  first by creation, so the queue drains in arrival order as items end. The reply to the queued request and "what's
  pending" both say it is waiting for a free worker.
- **Stopping.** `stop_work` (one task, or everything the person may stop) records a
  `task.cancelled` per item in the same commit as the reply, with its narration and a pending
  forward. The forward sends the worker thread a `thread.stop`, which ends its run and holds anything
  queued behind it, then stops the subagents it started, with ids derived from the stop event, so
  a crash after the reply still stops each once. A refused stop is tried once more under ids keyed by
  the run still alive, since a refused command id is refused for good, and counts as done only
  when nothing is left running there. A launch in flight when the stop came lands on the thread id the task's
  generation derives, so the forward waits up to two minutes for that thread and stops it. Work
  never claimed for a launch is stopped by the ledger write alone. A worker on another machine is
  stopped there through `goat_thread_interrupt` with `stopCascade`, the same `thread.stop` plus
  delegated-task walk, found through its report binding when its launch was still in flight. An
  older remote refuses the undeclared `stopCascade` argument before anything runs, so the stop
  retries once without it and only interrupts the turn there.

An owner has one bot, in the Scratch project, and one bot conversation keyed by the owner rather
than the thread. Where Scratch is off because the data directory is inside a Git work tree, the bot
gets a project of its own under the data directory instead: the bot never runs a provider or
checkpoints, so the repository around it does not matter. If the bot thread is deleted, the next
`ensureBot` starts a replacement and records it in its place. The conversation, its open
questions, and outstanding work carry over; deliveries addressed to the old thread go to the
current bot, and timeline ids include the thread so a replayed record lands in the replacement
without colliding with the old one.

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

## iMessage on a local Mac

The opt-in `imessage-channel-settings.json` in the server state directory holds a stable connection
ID, normalized allowed handles, and a scoped owner. The worker owner polls the current user's
Messages `chat.db` with a separate read-only SQLite connection, ordered by message ROWID. The
first poll begins at the current maximum; later passes checkpoint only after each input's durable
gateway receipt. A bounded pending set retries rows seen before their chat join is committed.
Both cursor and pending IDs share one fenced ledger record. A database reset requires an operator
decision rather than silently replaying history.

Only allowlisted direct iMessage text is admitted, and a link code establishes the sender's
identity before work can be requested. Reception and dispatch consult the current link again.
The home claim and owner token guard polling; outbound transport checks the home again. Replies
use the existing chat GUID through a fixed AppleScript with data passed as arguments. A successful
osascript call means Messages accepted the request, not that a person received it; uncertain
outcomes remain ambiguous in the outbox. The app launching the server needs Full Disk Access to
read Messages, and sending requires separate Automation permission for Messages.

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
