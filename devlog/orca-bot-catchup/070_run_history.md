# 070 — Run history says why (G11)

**Class:** C3. **Severity:** P2. **Depends on:** 010.

## Problem

Home shows seven run dots per routine (`apps/web/src/components/goatBot/GoatBotRoutineRuns.tsx:134`). It cannot say whether a run came from the timer, a person (**Run now**) or an event, nor show deliveries that were filtered, duplicated, missed while offline or unreadable; Deliveries exist only in Settings (`docs/user/project-settings.md:196`). Orca separates these (`274_orca/src/shared/automations/history/automation-run.ts:6`).

## Change

1. **Contract**: recent-run entries gain `origin: "schedule" | "manual" | "event"` and, for events, the delivery outcome (`accepted | filtered | duplicate | coalesced | rejected`); a read failure is its own state, never "no runs".
2. **Server**: `ScheduledTaskRuns.ts` records origin; the bot routine read joins the webhook delivery log.
3. **Web/desktop**: a routine's run list (opened from the dots) labels origin and outcome, links the resulting task, and offers **Deliveries** for trigger rows.
4. **Mobile**: `MobileRoutineRunStrip.tsx` labels the same.

## Tests (failing first)

- `ScheduledTaskService.recentRuns.test.ts`: manual, timer and event runs report their origin; a filtered delivery appears with the failing filter.
- Browser test: a read failure shows "Couldn't read runs", not an empty list.

## Acceptance

From a bot's Home a person can tell, for each of the last runs, why it ran and what came of it, and reach the deliveries of a trigger.

## Verification floor

Focused tests; `vp run check:changed`; review lane.
