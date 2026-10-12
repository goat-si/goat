# ADR-0011 — decision recorded under "Gateway"

- Contract owner: [channels.md](../channels.md#gateway)
- Commit: `c82962d4d1cdddadcaddfe560438afcbd48f72b4` (2026-10-12)

## Decision record

- 목적과 의도: Accept input from the GOAT bot, Slack, and agents at the same time, answer each without waiting for a worker, keep them apart, and send results back where they came from.
- 기존 구현 및 제약 조건: The message says the contracts landed in an earlier pull request and this commit adds the server side in `apps/server/src/channels/`. It also says `slackChannel` capability stays false in this commit, with Slack assembly left to a later change.
- 검토한 주요 대안: The message does not record a rejected ledger design. It states there is no tool that sends to an arbitrary channel, by shipping a fixed `channel_*` tool list.
- 선택한 방식: Migration `064_ChannelLedger` creates conversations, bindings, an inbox deduplicated by idempotency key, tasks with append-only events, an outbox deduplicated by cause, identity links, and fenced workers. `ChannelGateway.ingest` stores the input and returns a receipt without waiting for a model. The GOAT bot is one canonical thread per owner. Timeline writes use `channel.timeline.record`. A provider run on the bot thread is refused. Reception and dispatch launch worker threads under the requester's ceiling.
- 다른 대안 대신 이 방식을 선택한 이유: The message wants one ledger for three sources and a receipt that does not wait on the worker.
- 장점, 단점 및 영향: `apps/server/src/channels/ChannelGateway.ts`, `ChannelLedger.ts`, and `ChannelBotRegistry.ts` are still that path. Slack now has `apps/server/src/channels/slack/SlackChannelAdapter.ts`, which is later than the capability flag this commit left false. Web and mobile bot screens read the same thread. They are not a second store.
