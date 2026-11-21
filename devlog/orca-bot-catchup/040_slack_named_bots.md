# 040 — Slack reaches named bots (G08)

**Class:** C4 (routing authority). **Severity:** P1. **Decision:** D3. **Depends on:** 050 for the private-memory rule below if 050 lands first; otherwise none.

## Problem

`apps/server/src/channels/ChannelGateway.ts:382` returns `main` for every Slack input and the conversation write stores no chosen bot (`ChannelLedger.ts:920`). Home and task detail select GOAT conversations only (`apps/server/src/channels/ChannelBotThreads.ts:423`, :551), so Slack work would neither list nor open in a member's Home. Orca gives each bot a Slack app with **Who can ask** in the connector settings (`274_orca/src/renderer/src/components/bots/slack/BotSlackSetupDialog.tsx:323`); akeru binds a channel to a bot and project (`030` T3-02).

## Decision D3

Recommendation: one Slack app; a person binds Slack channels to bots; a DM or mention may name a bot ("Scout: …"). Options: (a) recommended; (b) one Slack app per bot; (c) keep main-only.

## Change

1. **Contract**: Slack settings gain `botBindings: Array<{ channelId, botId }>` (≤ 100), saved through the existing Slack settings path (`apps/server/src/channels/SlackChannelSettings.ts`); Slack settings stay outside `SETTINGS_ACCESS`.
2. **Routing, decided once per Slack thread**: on the first admitted message of a workspace/connection/channel/thread, resolve the bot with precedence explicit name > channel binding > main, and persist it with the conversation in the same write as the input. Later messages use the stored bot; rebinding or renaming affects new threads only. Threads admitted before this change have no stored bot and stay with main.
3. **Names**: create and rename refuse a name that matches another active bot case-insensitively (`ChannelBotMembers.ts`). Data from before that rule may still hold duplicates, so an explicit name that matches several active bots, matches none, or names a hidden or deleted bot gets a private Slack reply listing reachable bots and starts nothing.
4. **Unbind and deletion**: unbinding sends new threads to main. A thread stored for a bot that was later deleted gets a private reply ("Scout was deleted; restore it in GOAT or start a new thread") and starts nothing — never a silent move to main.
5. **Access**: routing picks the bot; who may ask stays per person (link levels, channel allowlist, `channelSenderAuthority.ts`). Routing never grants memory: private notes of the chosen bot enter reception, recall or a worker brief only for a sender independently allowed to use GOAT memory (an unlinked sender today "cannot use GOAT memory", `docs/user/slack.md:40`).
6. **Home**: `ChannelBotThreads.ts` lists a member bot's Slack-origin tasks in its Home Work, scoped by `bot_id`, and the authorized task-detail read (:542–554) opens those same rows.
7. **Delivery**: `SlackChannelAdapter.ts` prefixes member replies with the bot's name; with `chat:write.customize` granted, it sets `username`/`icon_url` instead.
8. **Clients**: Settings → GOAT Bot → Slack **Channels** gets a bot picker (web/desktop); mobile shows bindings read-only; a member's Home shows "Reachable in Slack: #eng" on both.
9. **Docs**: `docs/user/slack.md`, `docs/user/goat-bot.md`.

## Tests (failing first)

In `apps/server/src/channels/slack/SlackChannelScenarios.test.ts` with `slackSdkFake.ts`: bound channel → member; unbound → main; "Scout: hi" DM → Scout; thread stays with Scout after rebinding; a thread admitted before the upgrade stays with main; unknown, hidden, deleted and duplicated (pre-existing) names → private reply, no task; thread of a deleted bot → private reply, no task; a low-access unlinked sender routed to a bot with private notes gets no notes in its reception input. `ChannelBotMembers.test.ts`: duplicate name refused. `ChannelBotThreads.test.ts`: a Slack-origin task lists **and opens** in the member's Home.

## Acceptance

1. A message in a bound channel is answered by the member bot under its name, and its task lists and opens in that bot's Home on web, desktop and mobile.
2. Follow-ups in a thread stay with the bot that took it; older threads stay with main.
3. Unknown, ambiguous, hidden and deleted targets never fall through silently.
4. Access and memory rules behave as before on every route.

## Verification floor

Focused tests; `vp run check:changed`; independent review. Before merge: web/desktop captures of the binding picker and the member's Home opening a Slack task; iOS simulator and Android emulator capture of that Home. Live Slack: NOT RUN (no workspace credentials), stated in the PR.
