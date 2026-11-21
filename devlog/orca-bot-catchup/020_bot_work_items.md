# 020 — Bot work says what done means (G03)

**Class:** C4 (persisted state, wire fields). **Severity:** P1. **Depends on:** nothing.

## Problem

A bot task row is a title, a status and PR chips (`packages/contracts/src/channelGateway.ts:528`). A person cannot see what the bot will count as finished or what happened along the way, and cannot set a task aside. Orca's item carries `doneMeans`, a typed event history, linked workers with PR checks and review, and `snoozedUntil` (`274_orca/src/shared/bots/bot-item-schema.ts:121`).

## Change

1. **Done means**: optional `doneMeans` (≤ 280 chars) on the task record and `BotTaskSummary`. The bot sets it when it starts a task (`apps/server/src/channels/channelSessionTaskActions.ts`); the worker brief (`channelWorkerBrief.ts:116`) asks the worker to report against it. Stored with the task (nullable column, next migration).
2. **Activity**: `ChannelBotTaskActivity` returned by the existing task read (`ChannelGetBotTaskInput`, `channelGateway.ts:573`), newest 50, each entry typed with its subject: `created`, `status`, `worker_started {environmentId, threadId}`, `worker_finished {…}`, `pr_linked {repo, number}`, `asked {requestId}`, `answered {requestId}`, `snoozed`, `unsnoozed`, with actor `bot | person | goat`. Projected from durable facts the ledger already holds (`channelTaskTransitions.ts`, `channelTaskChanges.ts`, launch records); PR links are a snapshot, so the list says "Activity before <date> may be incomplete" for older tasks. No second log.
3. **Snooze**: lives in the per-person task-view record beside pin, done and read (`apps/server/src/channels/channelTaskViews.ts:59`) as `snoozedUntil`. Like pin and done, snooze is keyed by environment owner and task (`channelTaskViews.ts:38`), so it is shared by everyone acting as that owner. A snoozed task leaves Home's recent list and unread counts until the time passes or the task changes status; the view read computes expiry, and an open Home sets one timeout for the earliest expiry and re-reads then (`ChannelWake.ts` wakes workers, not clients). **Open questions and approvals stay in Needs you**; snooze mutes noise, never asks. RPCs `channel.bot_task_snooze`/`unsnooze` added to `CLIENT_GUARDED_RPC_SCOPES` (`packages/contracts/src/clientRpcPermissions.ts`).
4. **Workers**: the task read already returns several local and remote workers; first verify how `GoatBotTaskPane.tsx` renders them and only then add what is missing.
5. **Web/desktop**: `GoatBotTaskPane.tsx` shows Done means under the title, Activity, every worker with its PR; the task menu gets Snooze (1 hour, tomorrow, next week) and Unsnooze; Home gets a "Snoozed" fold.
6. **Mobile**: `MobileTaskHeader.tsx` Done means, `mobileBotWorkDetails.tsx` Activity, `MobileTaskActions.tsx` Snooze/Unsnooze. A client talking to an older server hides Snooze.
7. **Agents**: the channel task read tool returns `doneMeans` and activity; snooze is a person action.
8. **Docs**: `docs/user/goat-bot.md` Work.

## Tests (failing first)

- `apps/server/src/channels/ChannelBotThreads.test.ts`: done-means round-trips; activity lists worker start, PR link and question with subjects, newest first, capped.
- `apps/server/src/channels/channelTaskViews.test.ts`: snoozed task leaves recent rows and unread; it returns at expiry (TestClock) and on a status change; an open question on a snoozed task stays in open asks (`ChannelOpenAsks.test.ts`).
- Migration test beside the new migration; mixed version: a client without Snooze support never sends it.
- `apps/web/src/components/goatBot/GoatBotTaskPane.browser.test.tsx`: Done means and two workers visible; Snooze hides the task from Home, Unsnooze restores it.

## Acceptance

1. A task the bot starts shows a one-sentence Done means on web, desktop and mobile.
2. Activity shows which worker started, which PR was linked and which question was asked, newest first.
3. Snooze and Unsnooze work from both clients, survive restart, and never hide an open ask.
4. Tasks without the new fields render as today; older servers hide Snooze.

## Verification floor

Focused tests; `vp run check:changed`; migration test; independent review. Before merge: web/desktop and iOS simulator and Android emulator captures with the Replay provider.
