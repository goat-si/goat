# 040 — Slack reaches named bots (G08)

**Class:** C4 (routing authority). **Severity:** P1. **Decision:** D3. **Depends on:** nothing.

## Problem

`apps/server/src/channels/ChannelGateway.ts:382` returns `main` for every Slack input, so a member bot is reachable only in the GOAT app. Orca gives each bot its own Slack app with "Who can ask" (`274_orca/src/renderer/src/components/bots/slack/BotSlackSetupDialog.tsx:120`); akeru binds a channel to a bot and project (`030` T3-02).

## Decision D3

Recommendation: keep one Slack app and route by **channel binding** (a Slack channel ID → a bot, set in Settings → GOAT Bot → Slack) plus a **name prefix** in DMs and mentions ("Scout: …" or "@goat Scout …"). Replies carry the bot's name as a prefix; `chat:write.customize` (name and icon per message) is used only if the workspace grants it. Options: (a) recommended; (b) one Slack app per bot (more setup for users, mirrors Orca); (c) keep main-only.

## Change

1. **Contract**: `SlackChannelSettings` gains `botBindings: Array<{ channelId, botId }>` (≤ 100). Saved through the existing Slack settings path (`apps/server/src/channels/SlackChannelSettings.ts`); Slack settings are not part of `SETTINGS_ACCESS` today and this unit keeps it that way.
2. **Server**: `ChannelGateway.checkCaller` Slack case resolves the bot from the binding, then from a leading bot name (case-insensitive, active members only), else `main`. The sender's access level and channel allowlist apply unchanged; a binding never widens who may ask. Slack thread → bot is sticky after the first message (stored with the conversation), so a rename or rebinding does not move an open thread.
3. **Delivery**: `SlackChannelAdapter.ts` prefixes replies with the bot name for member bots; with `chat:write.customize` it sets `username` and `icon_url` instead.
4. **Web/desktop**: Settings → GOAT Bot → Slack **Channels** list gains a bot picker per channel. A member bot's Home shows "Reachable in Slack: #eng" when bound.
5. **Mobile**: read-only binding display in Settings → GOAT Bot.
6. **Docs**: `docs/user/slack.md` and `goat-bot.md` ("Slack and iMessage talk to the main bot" becomes the new rule).

## Security note

Routing decides which bot answers, never who may ask; access ceilings stay per person. Deleted or hidden bots: deleted → falls back to main with a one-line notice; hidden → still answers.

## Tests (failing first)

- `apps/server/src/channels/slack/SlackChannelScenarios.test.ts`: a bound channel's mention reaches the member bot; an unbound channel reaches main; "Scout: hi" in a DM reaches Scout; a thread started with Scout stays with Scout after the binding changes; an unlinked person bound to Scout still works at "Access without a link".
- Settings test: a binding to a deleted bot is refused.

## Acceptance

1. A message in a bound channel is answered by the member bot, with its name, and its task appears in that bot's Home.
2. DM name prefix routes; unknown name routes to main and says which bots exist.
3. Access levels behave exactly as before for every route.

## Verification floor

Focused tests with the Slack SDK fake (`slackSdkFake.ts`); `vp run check:changed`; review lane. Live Slack: NOT RUN (no workspace credentials); stated in the PR.
