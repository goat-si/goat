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
