# 110 — Agents propose bots (G17)

**Class:** C4 (tool schema, authority). **Severity:** P3. **Decision:** D4. **Depends on:** 060.

## Problem

Agents can list bots (`packages/contracts/src/agentSurface/entries/channel.ts:132`) but cannot suggest one. MCP ingress runs as a namespaced agent principal with read scope; starting work and answering questions are reserved for people (`entries/channel.ts:85`, `apps/server/src/mcp/toolkits/channel/handlers.ts:63`). Orca's CLI proposes bot cards a person approves (`274_orca/src/cli/bots/bot-create.ts:89`).

## Decision D4

Recommendation: **propose only**. `goat_channel_bot_propose` posts a proposal card (template id or fields, plus why) into the main bot's chat; a person **Accept**s, which runs a fresh, authorized, idempotent create of exactly the reviewed proposal, or **Dismiss**es it; proposals expire after 7 days. Asking member bots stays out: if later wanted, it starts as report-only under the agent's own live scope, never the owner's. Options: (a) propose only; (b) propose and ask; (c) neither.

## Change

One entry in `entries/channel.ts`; handler calls `ChannelBotMembers.propose`; card on web/desktop/mobile with Accept/Dismiss; template listing for agents (read-only) from 060's catalog.

## Tests (failing first)

Tool contract test; a proposal changes nothing until accepted; Accept twice creates one bot; an expired proposal cannot be accepted; a read-scoped agent cannot create directly.

## Acceptance

An agent's proposal appears as a card on every client; accepting creates the reviewed bot once; dismissing or expiry leaves nothing.

## Verification floor

Focused tests; `vp run check:changed`; independent review; before merge, web capture of the card. Waits on D4.
