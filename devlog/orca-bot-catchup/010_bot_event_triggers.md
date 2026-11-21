# 010 — Events start a named bot (G01, G02)

**Class:** C4 (externally started runs, authority, wire contract). **Severity:** P1; G02 is its P0 gate. **Decision:** D1. **Depends on:** nothing.

## Problem

A bot routine runs on a timer and only answers: `apps/server/src/scheduledTasks/scheduledBotRoutines.ts:81` rejects webhook schedules and `apps/server/src/channels/channelRoutineInputs.ts:39` (`routineDecision`) turns any start-work decision into a reply. GitHub can already start a general scheduled task through a signed, filtered, deduplicated webhook (`docs/user/project-settings.md:143`), but not a bot. Orca binds "PR opened", "check failed" and webhook rules to a bot, lets the bot start workers, and excludes the bot's own PRs by repository-qualified identity (`274_orca/src/shared/automation-event-triggers.ts:17`, `src/main/connector-cloud/own-pr-trigger-guard.ts:37`).

## Authority today, and why it is not enough

A routine firing ingests with the scopes saved when the routine was created (`apps/server/src/channels/ChannelRoutineIntake.ts:122`), at `approval-required`. At dispatch, current scopes are re-read only for Slack and iMessage requesters (`apps/server/src/channels/channelDispatchAuthority.ts:46`). `approval-required` limits the runtime mode; the `<webhook-data-…>` fence only helps the model tell data from instructions. Neither stops an event from using stale scopes or steering existing work.

## Decision D1 (decision.request before B)

Recommendation: an event trigger may start **new work only**, in the trigger's own project, under a **revocable trigger grant** held by the person who created it and **re-checked at dispatch**. It cannot steer, stop or answer existing work, cannot write notes, and timer check-ins stay answer-only. Options: (a) recommended; (b) event runs answer only; (c) defer triggers.

## Change

1. **Contract** (`packages/contracts/src/scheduledTask.ts`): a bot routine may use the existing `webhook` schedule with `routineMode: "work"` (absent = `check_in`, today's behavior). A `work` routine requires a project and, for GitHub presets, `requireSignature: true`. New fields are optional, and an older writer that round-trips the record must keep them (test below).
2. **Admission** (`apps/server/src/scheduledTasks/ScheduledTaskService.ts:640`, :1595): the existing transaction that records a firing and its routine input carries the **rendered, fenced prompt** and the webhook delivery id instead of the saved template. Receipt settlement stays with channel intake (`ChannelRoutineIntake.ts:187`); the run's terminal state reports the resulting task's execution separately from "the bot replied".
3. **Authority**
   - `channelDispatchAuthority.ts` `requesterForDispatch`: for a schedule-origin task, re-read the trigger owner's current grant (`ChannelIdentityService` / owner record) and intersect, as Slack does; a revoked or reduced grant refuses the dispatch with a visible task error.
   - `channelRoutineInputs.ts` `routineDecision`: for `work`, allow only "start a task in the routine's project"; every other action becomes a reply. Always strip `remember`.
   - `ChannelRuntime.ts:280`: `work` inputs stay on the reception path (explicit action allowlist), never the bot's tool session.
   - Create, edit, enable, rebind, rotate and URL disclosure of a `work` trigger are person-only: `scheduledBotRoutines.ts` `checkUpsert` already refuses agents on create; extend it to update and enable, and refuse the MCP schedule update path from unbinding or rebinding a bot routine (`apps/server/src/mcp/OrchestratorMcpService.ts:1866`).
4. **Own-work exclusion**: new `apps/server/src/channels/channelRoutineOwnWork.ts` drops a `pull_request`, `check_suite` or `check_run` delivery whose repository-qualified PR (`owner/repo#number`) or head (`owner/repo` + branch) matches work this bot started (`channelBotRowPullRequests.ts:37` links plus the task's launch provenance). A check event that names no pull request is **Filtered: no pull request** unless the trigger opts in. Each exclusion is logged in Deliveries with its reason.
5. **Web/desktop**: Home **Routines** (`apps/web/src/components/goatBot/GoatBotRoutines.tsx`) gains **New trigger**: presets **Pull request opened**, **Check failed**, **Any webhook**, a project picker, the URL with Rotate (revealed to people with settings access only), signature setup, filters (reusing `ScheduledTaskWebhookFiltersField.tsx`). Trigger rows show "On webhook" and pause/resume.
6. **Mobile**: `MobileBotRoutines.tsx` lists trigger rows with pause/resume and how deliveries reach them; creation stays on web/desktop, as signature setup does today.
7. **Agents**: scheduled-task tools may list triggers; they cannot create, edit, enable or rebind `work` triggers.
8. **Docs**: `docs/user/goat-bot.md` Routines; link from `docs/user/project-settings.md` Webhook automations.

## Tests (failing first)

- `apps/server/src/scheduledTasks/ScheduledTaskService.botRoutine.test.ts`: person creates a `work` trigger; agent create, update, enable and rebind are refused; a signed delivery creates exactly one routine input carrying the rendered prompt; immediate, coalesced, restart-recovered and replayed deliveries each admit at most once.
- `apps/server/src/channels/ChannelRoutines.test.ts`: a `work` input that decides to start work creates one task in the routine's project; a cross-project start is refused; steer/stop/answer/remember become replies; a `check_in` input is unchanged.
- Authority (same file or `channelDispatchAuthority` test beside it): owner's grant revoked after admission → dispatch refused; trigger paused after admission → queued input refused.
- New `apps/server/src/channels/channelRoutineOwnWork.test.ts`: own PR by repo-qualified identity filtered; same branch name in another repository not filtered; check event without a PR filtered with its reason.
- Mixed version: an older-shaped upsert that omits `routineMode` does not clear it.
- `apps/web/src/components/goatBot/GoatBotRoutines.browser.test.tsx` (existing): New trigger → Pull request opened shows project, URL and signature; saving lists "On webhook".

## Acceptance

1. From a bot's Home a person creates a signed "Pull request opened" trigger for a project; a signed sample delivery makes that bot start one task in that project, visible in Home.
2. Duplicate, own-PR and unsigned deliveries start nothing and show in Deliveries with their reason.
3. Revoking the owner's access or pausing the trigger before dispatch stops the queued run with a visible reason.
4. Timer routines behave exactly as before.

## Verification floor

Focused tests above; `vp run check:changed`; independent review lane; before merge, a real-client capture on web of creating a trigger and the task a signed `curl` delivery starts; mobile capture of the trigger row.
