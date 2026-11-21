# 020 — Bot work says what done means (G03)

**Class:** C4 (persisted state migration, contract fields). **Severity:** P1. **Depends on:** nothing (parallel with 010).

## Problem

A bot task row is a title, a status and PR chips (`packages/contracts/src/channelGateway.ts:528`, `BotTaskSummary`/`BotTaskRow`). A person cannot see what the bot will count as finished, what happened along the way, or set a task aside. Orca's item carries `doneMeans`, an event history, a question, several linked workers with PR checks and review, and `snoozedUntil` (`274_orca/src/shared/bots/bot-item-schema.ts:121`).

## Change

1. **Contract**: add optional `doneMeans` (≤ 280 chars) and `snoozedUntil` to `BotTaskSummary`; add `ChannelBotTaskActivity` (bounded list, newest 50: `created`, `status`, `worker_started`, `worker_finished`, `pr_linked`, `asked`, `answered`, `snoozed`, `unsnoozed`, each with actor `bot | person | goat` and time) returned by the existing get-task read (`ChannelGetBotTaskInput`, :576). Add `channel.bot_task_snooze` / `unsnooze` RPCs guarded in `CLIENT_GUARDED_RPC_SCOPES`.
2. **Server**
   - Migration: `done_means` and `snoozed_until` columns on the channel task table (`apps/server/src/channels/channelTables.ts`); next free migration number.
   - The bot sets `doneMeans` when it starts a task: extend the dispatch decision in `channelSessionTaskActions.ts` and the worker brief (`channelWorkerBrief.ts:116`) so the worker reports against it.
   - Activity is derived from existing ledger events (`channelTaskTransitions.ts`, `channelTaskChanges.ts`, `channelBotRowPullRequests.ts`), not a new log, so no double write.
   - Snoozed tasks leave Home's recent list and **Needs you** until the time passes or the task changes; `ChannelWake.ts` re-surfaces them.
3. **Web/desktop**: `GoatBotTaskPane.tsx` shows **Done means** under the title, an **Activity** list, and every worker (not only the first) with its PR state; the task menu gains **Snooze** (1 hour, tomorrow, next week) and **Unsnooze**. The Home list shows a "Snoozed" fold.
4. **Mobile**: `MobileTaskHeader.tsx` shows Done means; `mobileBotWorkDetails.tsx` the activity; `MobileTaskActions.tsx` Snooze/Unsnooze.
5. **Agents**: the channel task read tool returns `doneMeans` and activity; snooze stays a person action (person-decided, like pin).
6. **Docs**: `docs/user/goat-bot.md` Work section.

## Compatibility note

New fields are optional; an older client ignores them and an older server never sends them. The migration adds nullable columns only. Rollback to an older GOAT leaves the columns unread.

## Tests (failing first)

- `apps/server/src/channels/ChannelBotThreads.test.ts` (or the task read's test file): a task started with done-means returns it; activity lists worker start, PR link and question in order; snoozed task is absent from recent rows and returns when the snooze ends (TestClock).
- Migration test beside the new migration.
- `apps/web/src/components/goatBot/GoatBotTaskPane.browser.test.tsx`: Done means and two workers are visible; Snooze hides the task from Home and Unsnooze restores it.

## Acceptance

1. A task the bot starts shows a one-sentence Done means on web, desktop and mobile.
2. Activity shows who started which worker, linked which PR and asked what, newest first, capped.
3. Snooze and Unsnooze work from both clients and survive a server restart.
4. Tasks without the new fields render as today.

## Verification floor

Focused tests; `vp run check:changed`; migration test; independent review; M1 real-client pass with the Replay provider.
