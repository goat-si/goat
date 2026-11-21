# 030 — Alerts when a bot needs you (G04–G07)

**Class:** C4 (wire contract, native module, data leaving the app). **Severity:** P1. **Decision:** D2 for slice B. **Depends on:** nothing; with 020, snooze never mutes an ask.

## Problem

Nothing tells a person that a bot asked a question, needs an approval, failed or finished unless they are looking at it. Phone push is off until GOAT Connect (`packages/shared/src/goatConnect.ts:31`, `docs/user/mobile-notifications.md:1`). Web/desktop raise thread notifications (`apps/web/src/components/ThreadNotificationCoordinator.tsx:43`) but not bot events. Today's sources cannot drive alerts: `listOpenAsks` reads a snapshot (`apps/server/src/channels/channelOpenAsks.ts:124`), the task-change subscription sends coalesced revisions (`channelTaskChanges.ts:9`), and the Android module exposes configuration and the showcase activity but no general local alert (`apps/mobile/modules/goat-agent-notifications/android/src/main/java/expo/modules/goatagentnotifications/GoatAgentNotificationsModule.kt:14`). Orca's producer keeps question, approval, failure and completion distinct even though its wire groups them (`274_orca/src/shared/notifications/mobile-push-alert.ts:24`).

## Slice A — alerts while a client is running

1. **Attention feed** (server): a bounded table written in the same transaction as the transitions that create an ask or end a task (`channelTaskWrites.ts`, `channelRunOutcome.ts`). Each event: stable `eventId`, `kind` (`question | approval | sign_in | failed | finished`), `environmentId`, `botId`, `taskId`, `requestId?`, `generation` (so a retried attempt can alert again), time. Retained 7 days or 500 rows per owner. Clients read it with a cursor through a new read-authorized RPC; the same person-scoped authority as open asks.
2. **Setting**: `goatBotAlerts: "needs_you" | "needs_you_and_results" | "off"` (default `needs_you`) as a `person` key in `SETTINGS_ACCESS` (`packages/contracts/src/agentSurface/settingsAccess.ts`), in Settings → GOAT Bot.
3. **Web/desktop**: GOAT-owned `apps/web/src/components/goatBot/GoatBotAttentionNotifier.tsx` beside `ThreadNotificationCoordinator`; one OS notification per `eventId` (persisted cursor, so reconnect does not repeat), none while that bot's task is focused. Copy is generic: "Scout has a question" — bot name only, no task title or excerpt. Click re-reads the target with current authority, then opens the task and its request; a request already answered opens the task with the recorded answer.
4. **Mobile**: map feed events to `apps/mobile/src/features/agent-awareness/notificationPayload.ts` targets and post local notifications while the app is running. iOS: alerts stop when the system suspends the app; the docs say so and the PR records the measured limit. Android: add a general `postLocalAlert` to the native module. `notificationNavigation.ts` routes cold and warm taps after re-reading the target.
5. **Docs**: `docs/user/mobile-notifications.md` states what works over direct pairing (alerts while the app runs) and what waits on slice B.

## Slice B — a closed phone (stops at D2)

Needs a sender: GOAT Connect's relay or APNs/FCM keys GOAT does not hold. D2 options: (a) wait for GOAT Connect; (b) maintainers provide sender credentials; (c) a user-run ntfy-style topic. Recommendation (a). Content rule for any sender: generic copy plus an opaque target, rich previews opt-in, per-host opt-out. Recorded NEEDS_HUMAN with the decision id.

## Tests (failing first)

- `apps/server/src/channels/ChannelOpenAsks.test.ts` and a new feed test: one question writes one event; reconnect with the cursor returns none; a retry (new generation) writes a new one; failed and finished stay distinct; feed respects its bound.
- `GoatBotAttentionNotifier.browser.test.tsx`: one notification per event; none while focused; none when `off`; copy contains no task title.
- `apps/mobile/src/features/agent-awareness/notificationNavigation.test.ts`: bot targets route to task and request, cold and warm; a stale request opens the task.

## Acceptance

1. Web/desktop: a bot question raises exactly one notification with generic copy; click opens that question; reconnecting does not repeat it.
2. Android with the app running: same, through the new native method. iOS: same while running; behavior after suspension is documented with the measured limit.
3. `off` stops all bot alerts.
4. G04 and G05 closed; G06 and G07 stay open (partial) until D2.

## Verification floor

Focused tests; `vp run check:changed`; independent review; before merge, captures on web and the Android emulator with the Replay showcase approval. Slice B: NOT RUN until D2.
