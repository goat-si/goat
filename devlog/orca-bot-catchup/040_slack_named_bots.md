# 040 — Slack reaches named bots (G08)

**Class:** C4 (routing authority). **Severity:** P1. **Decision:** D3. **Depends on:** nothing.

## Problem

`apps/server/src/channels/ChannelGateway.ts:382` returns `main` for every Slack input. A member bot is reachable only in the GOAT app. Home and task lookup select GOAT conversations (`apps/server/src/channels/ChannelBotThreads.ts:423`), so Slack work would not appear in a member's Home even if routed. Orca gives each bot a Slack app with **Who can ask** in the connector settings (`274_orca/src/renderer/src/components/bots/slack/BotSlackSetupDialog.tsx:323`); akeru binds a channel to a bot and project (`030` T3-02).

## Decision D3

Recommendation: one Slack app; a person binds Slack channels to bots; a DM or mention may name a bot ("Scout: …"). Options: (a) recommended; (b) one Slack app per bot; (c) keep main-only.

## Change

1. **Contract**: Slack settings gain `botBindings: Array<{ channelId, botId }>` (≤ 100), saved through the existing Slack settings path (`apps/server/src/channels/SlackChannelSettings.ts`); Slack settings stay outside `SETTINGS_ACCESS`.
2. **Routing, decided once per Slack thread**: on the first admitted message of a workspace/connection/channel/thread, resolve the bot with precedence explicit name > channel binding > main, and persist it with the conversation in the same write as the input (`ChannelLedger.ts:920`). Later messages in that thread use the stored bot; rebinding or renaming affects new threads only.
3. **Names**: active bot names are unique case-insensitively (enforced at create/rename in `ChannelBotMembers.ts`); an explicit name that matches no active bot, or a hidden/deleted one, gets a private Slack reply listing reachable bots and starts nothing.
4. **Unbind and deletion**: unbinding sends new threads to main. A thread stored for a bot that is later deleted gets a private reply ("Scout was deleted; restore it in GOAT or start a new thread") and starts nothing — never a silent move to main.
5. **Access**: routing picks the bot; who may ask stays per person (link levels, channel allowlist, `channelSenderAuthority.ts`).
6. **Home**: `ChannelBotThreads.ts` lists a member bot's Slack-origin tasks in its Home Work, scoped by `bot_id`, with the existing "work whose ending the chat never told keeps its card" rule.
7. **Delivery**: `SlackChannelAdapter.ts` prefixes member replies with the bot's name; with `chat:write.customize` granted, it sets `username`/`icon_url` instead.
8. **Clients**: Settings → GOAT Bot → Slack **Channels** gets a bot picker (web/desktop); mobile shows bindings read-only; a member's Home shows "Reachable in Slack: #eng".
9. **Docs**: `docs/user/slack.md`, `docs/user/goat-bot.md`.

## Tests (failing first)

In `apps/server/src/channels/slack/SlackChannelScenarios.test.ts` with `slackSdkFake.ts`: bound channel → member; unbound → main; "Scout: hi" DM → Scout; thread stays with Scout after rebinding; unknown or hidden name → private reply, no task; thread of a deleted bot → private reply, no task; unlinked person keeps "Access without a link". `ChannelBotMembers.test.ts`: duplicate name refused. `ChannelBotThreads.test.ts`: Slack-origin task appears in the member's Home.

## Acceptance

1. A message in a bound channel is answered by the member bot under its name, and the task appears in that bot's Home on web and mobile.
2. Follow-ups in a thread stay with the bot that took it.
3. Unknown, hidden and deleted targets never fall through silently.
4. Access levels behave as before on every route.

## Verification floor

Focused tests; `vp run check:changed`; independent review; before merge, web capture of the binding picker and Home. Live Slack: NOT RUN (no workspace credentials), stated in the PR.
