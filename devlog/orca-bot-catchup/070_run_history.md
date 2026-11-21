# 070 — Run history says why (G11)

**Class:** C4 (wire contract). **Severity:** P2. **Depends on:** 010.

## Problem

Home shows seven run dots per routine (`apps/web/src/components/goatBot/GoatBotRoutineRuns.tsx:134`) without saying whether a run came from the timer, **Run now** or an event. Runs already store `trigger_kind` and the webhook delivery id (`apps/server/src/scheduledTasks/ScheduledTaskRuns.ts:434`). Filtered and duplicate deliveries create no run; they live in the Deliveries log, shown only in Settings (`docs/user/project-settings.md:196`).

## Change

1. **Runs**: the recent-runs read (`scheduledTaskRecentRuns.ts`) projects the stored `trigger_kind` as `origin: "schedule" | "manual" | "event"` and links the resulting task. An unreadable or budget-truncated history is its own state, never "no runs".
2. **Deliveries**: a trigger row offers **Deliveries**, reusing the existing bounded Deliveries read under its existing permissions; deliveries stay a separate list from runs.
3. **Missed**: only the detectable case is shown — a timer firing skipped while the server was down, if the scheduler records it; otherwise "missed" stays out of scope and G11 records it as open.
4. **Clients**: web/desktop run list from the dots; mobile `MobileRoutineRunStrip.tsx` labels origin.

## Tests (failing first)

`ScheduledTaskService.recentRuns.test.ts`: manual, timer and event runs report origin; an unreadable history differs from an empty one. Browser test: a read failure shows "Couldn't read runs".

## Acceptance

From a bot's Home a person can tell why each recent run ran, open its task, and reach a trigger's deliveries.

## Verification floor

Focused tests; `vp run check:changed`; independent review; before merge, web capture.
