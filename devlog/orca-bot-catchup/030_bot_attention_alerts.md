# 030 — Alerts when a bot needs you (G04–G07)

**Class:** slice A C3, slice B C4. **Severity:** P1. **Decision:** D2 for slice B. **Depends on:** nothing; 020's snooze suppresses alerts once both land.

## Problem

Nothing tells a person that a bot asked a question, needs an approval, failed, or finished, unless the app is open on that bot. Phone push is disabled until GOAT Connect (`packages/shared/src/goatConnect.ts:31`, `docs/user/mobile-notifications.md:1`). Web/desktop already raise thread notifications (`apps/web/src/components/ThreadNotificationCoordinator.tsx:43`) but not bot events. Orca and threebot both alert and deep-link to the exact request, keeping questions, approvals, failures and completions distinct (`274_orca-analysis/020` EV-07, `030` T3-01).

## Slice A — what GOAT can ship now

1. **Contract**: `BotAttentionEvent` = `{ kind: "question" | "approval" | "failed" | "finished" | "sign_in", botId, taskId, requestId?, title, at }` with a target that the clients resolve to `bot → task → request`. Pushed on the existing channel subscription that feeds **Needs you** (`channelOpenAsks.ts`), so no new socket.
2. **Server**: emit from the points that already settle these states (`channelOpenAsks.ts:45`, `channelRunOutcome.ts`, `ChannelWorkerReports.ts`), bounded and deduplicated by `(taskId, requestId, kind)`.
3. **Settings**: `goatBotAlerts: "needs_you" | "needs_you_and_results" | "off"` (default `needs_you`) as a `person` key in `SETTINGS_ACCESS` (`packages/contracts/src/agentSurface/settingsAccess.ts`), shown in **Settings → GOAT Bot**.
4. **Web/desktop**: new GOAT-owned `apps/web/src/components/goatBot/GoatBotAttentionNotifier.tsx` mounted beside `ThreadNotificationCoordinator`; uses the same permission flow; suppressed while that bot's chat or task is focused; click opens the task (and the request card). Copy is generic by default ("Scout has a question") — no message excerpt.
5. **Mobile**: map `BotAttentionEvent` into `apps/mobile/src/features/agent-awareness/notificationPayload.ts` targets and post a local notification while the app is running or backgrounded with a live socket; `notificationNavigation.ts` routes a tap to bot → task → request, cold and warm. Android uses the existing `goat-agent-notifications` module.
6. **Docs**: `docs/user/mobile-notifications.md` says what works over direct pairing (alerts while the app is running) and what waits on slice B.

## Slice B — remote push (stops at decision D2)

Remote delivery to a closed phone needs a sender: GOAT Connect's relay, or APNs/FCM keys GOAT does not hold. D2 options: (a) wait for GOAT Connect and keep slice A; (b) maintainers provide APNs/FCM sender credentials for a direct sender; (c) a user-run ntfy-style topic. Recommendation: (a). The unit records BLOCKED/NEEDS_HUMAN for slice B rather than shipping a partial sender. Content policy for slice B: generic copy plus an opaque target, rich previews opt-in, per-host opt-out.

## Tests (failing first)

- Server: one question emits one `question` event; answering it does not emit again; failed vs finished stay distinct (channel test beside `channelOpenAsks`).
- `GoatBotAttentionNotifier.browser.test.tsx`: a question while another view is focused shows one notification; while the bot's task is focused, none; setting `off` shows none.
- Mobile: `notificationNavigation.test.ts` routes a bot question target to the task and request; an already-answered request opens the task with its recorded answer.

## Acceptance

1. Web/desktop: a bot question raises one OS notification with generic copy; clicking it opens that task's question.
2. Mobile with the app backgrounded and connected: same, with tap routing cold and warm.
3. The setting turns alerts off; muting is per environment.
4. Slice B is recorded as waiting on D2 with the decision id.

## Verification floor

Slice A: focused tests, `vp run check:changed`, review lane, real-client pass on web and mobile (Replay showcase raises an approval). Slice B: NOT RUN until D2.
