# Channels and GOAT Bot

A channel is one inbound conversation the server accepts, answers, and replies to on the same
path. `ChannelKind` in `packages/contracts/src/channelCommon.ts` is `goat`, `slack`, `mcp`, or
`imessage`. The four kinds share a ledger. They do not share a thread.

The [command commit](server.md#command-commit) still owns coding work. Channel reception can ask
for a worker thread. It does not run the provider inside the bot thread.

## Gateway

`ChannelGateway` in `apps/server/src/channels/ChannelGateway.ts` is the entry for ingest and
identity links. `ingest` stores the input and returns a receipt. Reception, ledger updates, and
replies happen after that return. Adapters do not send replies themselves.

`ChannelBotHome.requireHome` in `apps/server/src/channels/ChannelBotHome.ts` rejects ingest when
`settings.goatBotHome` says another environment is the cluster home. The claim schema is
`GoatBotHomeClaim` in `packages/contracts/src/settings.ts`. Servers do not sync the claim with
each other: clients copy the newest claim to every server they reach. So a claim naming a
vanished environment blocks the bot everywhere until someone moves it, either from a client or
through `ChannelBotHome.claimHere` (the `channel_bot_home_claim` MCP tool), which writes a newer
claim for its own server and rechecks inside the settings write lock that the caller still has full access.

Slack is one adapter. `apps/server/src/channels/slack/SlackChannelAdapter.ts` maps Socket Mode
envelopes into `ChannelGateway.ingest` and posts outbound through the Slack API.
`apps/server/src/channels/slack/SlackChannelRuntime.ts` holds the socket session per connection.
Slack settings for that connection are `slack-channel-settings.json` under the state directory
(`apps/server/src/channels/slack/SlackChannelSettings.live.ts`), not `settings.json`.

The local Mac iMessage adapter in `apps/server/src/channels/imessage/` uses file settings,
read-only `chat.db` polling with a fenced cursor, and a fixed AppleScript send transport. Its
poller runs inside the channel worker owner's pass.

> Decision record: [ADR-0015](decisions/ADR-0015-imessage-channel.md)

> Decision record: [ADR-0011](decisions/ADR-0011-channel-ledger.md)

The ledger migration is `apps/server/src/persistence/Migrations/071_ChannelLedger.ts`. It creates
`channel_conversations`, `channel_bindings`, `channel_inbox`, `channel_tasks`,
`channel_task_events`, `channel_outbox`, `channel_runtime_state`, `channel_identities`, and
`channel_identity_links`. `ChannelLedger` reads them through `SqlClient`.

## Reception and dispatch

`ChannelRuntime` runs a pass over pending inputs and calls `ChannelReceptionService.receive` in
`apps/server/src/channels/ChannelReceptionService.ts`. A reception that chooses `create_task`
writes a task. A later pass has `ChannelDispatcher` in `apps/server/src/channels/ChannelDispatcher.ts`
launch a worker thread through `ThreadLaunchService.launch`, with the task text as the initial
message. The worker is an ordinary thread. Its completion is delivered back on the channel outbox.

A reception may first choose `read`: `ChannelReceptionService` runs the lookups (bot notes from
`channelBotNotes.ts`, a journal built from ledger tasks, GOAT memory through `MemoryService.search`,
ledger tasks,
worker thread messages through `ThreadManagementService.getThreadRecords`, and
`ChannelLedger.searchConversation`) and generates once more with the results. Matching,
visibility (`canSeeTask`) and size bounds are pure functions in
`apps/server/src/channels/channelBotRecall.ts`.

Channel observations keep agent-reported tests separate from the check run by the worker's host.
A late check updates the bound run's evidence without reopening the task or changing its outcome.
Local reconciliation and authenticated remote observation recover this evidence from persisted state.
An absent check remains pending until the check worker records a disposition; an explicit no-check
disposition ends observation without manufacturing a passing result. Web, mobile, Slack, and bot
recall present the two kinds of evidence separately.

MCP agents use the same ledger through the `channel_*` tools in [`mcp-toolkits.md`](mcp-toolkits.md).
`CHANNEL_MCP_TOOL_NAMES` has no tool that sends to an arbitrary channel.

`ChannelTaskExport` joins ledger outcome pairs with local native-question response provenance
and memory lineage through existing read services; `ChannelLedger` exports the ledger outcome snapshots.
Both human answer counters are scoped to the outcome's generation, stop at the terminal timestamp,
and exclude native resolutions produced by channel-forward commands. Reruns remain task-cumulative. Notes hashes are frozen at launch. Memory lineage is observed at export
time and is cumulative for the worker thread, including ancestor revisions and memory delivered
after the outcome; it does not establish
which memory a particular run relied on. `unknown` and `overflow` retain incomplete evidence,
and remote threads are reported as unknown rather than as empty complete records.

## GOAT Bot

`ChannelBotRegistry.ensure` in `apps/server/src/channels/ChannelBotRegistry.ts` finds or creates
the canonical thread titled `GOAT bot` for an owner. `ChannelBotTimeline` in
`apps/server/src/channels/ChannelBotTimeline.ts` records bot timeline items with the orchestration
command `channel.timeline.record` and does not start a provider run for that write.

Clients render that timeline from shared helpers in `packages/client-runtime/src/goatBot/`.
`resolveGoatBotHome` in `packages/client-runtime/src/goatBot/home.ts` picks the environment that
holds the cluster home claim. Web screens live in `apps/web/src/components/goatBot/`.
`useGoatBotSession` sends with `kind: "goat"`. Mobile renders `GoatBotScreen` in
`apps/mobile/src/features/goat-bot/GoatBotScreen.tsx` and keeps a remembered thread-or-bot mode on
Home. Worker coding stays in the worker threads. The bot transcript is the messenger view.
