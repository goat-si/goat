# 010 — Events start a named bot (G01, G02)

**Class:** C4 (externally started runs, authority, contract change). **Severity:** P1, with G02 as its P0 gate. **Decision:** D1 below. **Depends on:** nothing.

## Problem

A bot routine runs on a timer and may only answer: `apps/server/src/scheduledTasks/scheduledBotRoutines.ts:81` rejects webhook schedules, and `apps/server/src/channels/channelRoutineInputs.ts:39` (`routineDecision`) turns any decision that would start work into a plain reply. GitHub can already start a general scheduled task through a signed, filtered, deduplicated webhook (`docs/user/project-settings.md:143`), but not a bot. Orca binds "PR opened", "check failed" and webhook rules to a bot and lets the bot start workers, excluding PRs the bot itself opened (`274_orca/src/shared/automation-event-triggers.ts:17`, `src/main/connector-cloud/own-pr-trigger-guard.ts:83`).

## Decision D1 (decision.request before B)

Question: may an event routine start work? Recommendation: yes. Event runs ingest as the routine owner (`ChannelRoutineIntake.ts:128`, ceiling stays `approval-required`), so anything needing approval lands in **Needs you**; timer check-ins stay answer-only. Options: (a) recommended; (b) event runs answer only, starting nothing; (c) event runs may start work only in the routine's project.

## Change

1. **Contract** (`packages/contracts/src/scheduledTask.ts`): a bot routine may use the existing `webhook` schedule. Add an optional `routineMode: "check_in" | "work"` on the routine record (absent = `check_in`, so older clients and rows keep today's behavior). Webhook schedules in a bot conversation require `work`.
2. **Server**
   - `scheduledBotRoutines.ts`: drop the webhook rejection at :81 for owned bot routines; keep "only a person can set up a routine" (:85). Persist `routineMode`.
   - `ScheduledTaskService.ts` webhook path: when the target is a bot routine, write the rendered, fenced prompt (the existing `<webhook-data-…>` wrapping) to `scheduled_task_channel_inputs` exactly as a timer firing does, so dedupe, coalescing, filters and the Deliveries log apply unchanged.
   - `channelRoutineInputs.ts`: `routineDecision` keeps today's answer-only rule for `check_in`; for `work` it passes start/steer decisions through. It still strips `remember` (an event payload never writes notes).
   - `ChannelRuntime.ts:280`: a `work` routine input may be offered to the bot session like a person's message; `check_in` stays reception-only.
   - Own-work exclusion: new `apps/server/src/channels/channelRoutineOwnWork.ts` drops a GitHub `pull_request`/`check_suite`/`check_run` delivery whose head branch or PR URL belongs to a task this bot started (read from `channelBotRowPullRequests.ts` links), logged as **Filtered: the bot's own work**.
3. **Web/desktop**: Home **Routines** (`apps/web/src/components/goatBot/GoatBotRoutines.tsx`) gains **New trigger** beside **New routine**: a small form reusing `ScheduledTaskWebhookFiltersField.tsx` with presets **Pull request opened**, **Check failed**, **Any webhook**. It shows the URL (with Rotate), the GitHub signature setup copy, and what the bot will be asked. Trigger rows show "On webhook" instead of a next-run time and keep pause/resume.
4. **Mobile**: `MobileBotRoutines.tsx` lists trigger rows with pause/resume and the URL to copy; creating one stays on desktop/web like signature setup does today (`docs/user/project-settings.md:170`).
5. **Agents**: the existing scheduled-task tools already carry webhook schedules; extend their bot-routine validation the same way. No new tool.
6. **Docs**: `docs/user/goat-bot.md` Routines paragraph gains triggers; `docs/user/project-settings.md` links to it.

## Security and compatibility note (required for C4)

- The run acts as the person who created the trigger, never above `approval-required`; the sender's identity grants nothing. Payload text stays fenced and mention-neutralized by the existing renderer.
- A signature is offered by default for GitHub presets; an unsigned trigger shows "Anyone with the URL can start this bot".
- Older clients see a webhook routine as a routine without a next run; they cannot create one. Older servers never receive `routineMode`.
- Reverse state: pause, delete, Rotate URL.

## Tests (failing first)

- `apps/server/src/scheduledTasks/ScheduledTaskService.botRoutine.test.ts`: a webhook schedule on a bot routine is accepted for a person and refused for an agent caller; a signed delivery creates exactly one channel input; a redelivery with the same duplicate key creates none.
- `apps/server/src/channels/ChannelRoutines.test.ts`: a `work` routine input that decides to start work creates a task under the routine owner at `approval-required`; a `check_in` input with the same decision still replies with `cannotStartWork`.
- New `apps/server/src/channels/channelRoutineOwnWork.test.ts`: a `pull_request.opened` whose head branch belongs to the bot's own task is filtered and logged; a human PR is not.
- `apps/web/src/components/goatBot/GoatBotRoutines.browser.test.tsx` (new): New trigger → Pull request opened shows the URL and signature fields; saving lists "On webhook".

## Acceptance

1. From a bot's Home a person creates a "Pull request opened" trigger; a signed sample delivery makes that bot start a task in the conversation, visible in Home.
2. A duplicate delivery starts nothing; a PR the bot opened starts nothing and shows as Filtered.
3. An unsigned delivery to a signed trigger is rejected with 401 and starts nothing.
4. Pausing the trigger stops runs; Rotate invalidates the old URL.
5. Timer routines behave exactly as before.

## Verification floor

`vp test run` on the files above; `vp run check:changed`; independent review lane before merge; real-client pass at milestone M1 (web: create trigger, deliver a sample with `curl` + HMAC to the dev server, see the task; mobile: trigger row visible and pausable).
