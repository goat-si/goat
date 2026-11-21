# 110 — Agents propose bots and ask them (G17)

**Class:** C4 (tool schemas, authority). **Severity:** P3. **Decision:** D4. **Depends on:** 060.

## Problem

Agents can list bots but cannot propose one or hand a request to a member bot (`packages/contracts/src/agentSurface/entries/channel.ts:86`, `docs/user/goat-bot.md:46`). Orca's CLI proposes bot and connector cards that a person approves, and lets bots ask each other (`274_orca/src/cli/bots/bot-create.ts:89`).

## Decision D4

Recommendation: (1) `goat_channel_bot_propose` creates a proposal card in the main bot's chat that a person accepts (creating via 060's path) or dismisses; (2) `goat_channel_bot_ask` sends a request into a member bot's conversation as the calling agent's owner at that owner's ceiling, shown as "from <thread>". Options: (a) both; (b) propose only; (c) neither.

## Change

Two entries in `packages/contracts/src/agentSurface/entries/channel.ts`, handlers in `apps/server/src/mcp/toolkits/channel/handlers.ts` calling one service method each (`ChannelBotMembers.propose`, `ChannelGateway.ingest` with a new `agent` caller). Proposal card renders on web/desktop/mobile with Accept/Dismiss.

## Tests (failing first)

Tool contract tests; a proposal changes nothing until accepted; an ask from an agent whose owner lacks the scope is refused.

## Acceptance

An agent's proposal appears as a card; accepting creates the bot; an ask lands in the member bot's chat attributed to the thread.

## Verification floor

Focused tests; `vp run check:changed`; independent review lane. Blocked until D4.
