# 010 — Events start a named bot (G01, G02)

**Class:** C4 (externally started runs, authority, wire contract). **Severity:** P1; G02 is its P0 gate. **Decision:** D1. **Depends on:** nothing.

## Problem

A bot routine runs on a timer and only answers: `apps/server/src/scheduledTasks/scheduledBotRoutines.ts:81` rejects webhook schedules and `apps/server/src/channels/channelRoutineInputs.ts:39` (`routineDecision`) turns any start-work decision into a reply. GitHub can already start a general scheduled task through a signed, filtered, deduplicated webhook (`docs/user/project-settings.md:143`), but not a bot. Orca binds "PR opened", "check failed" and webhook rules to a bot, lets the bot start workers, and excludes the bot's own PRs by repository-qualified identity (`274_orca/src/shared/automation-event-triggers.ts:17`, `src/main/connector-cloud/own-pr-trigger-guard.ts:37`).

## Authority today, and why it is not enough

A routine firing ingests with the scopes saved when the routine was created (`apps/server/src/channels/ChannelRoutineIntake.ts:122`), at `approval-required`. At dispatch, current scopes are re-read only for Slack and iMessage requesters (`apps/server/src/channels/channelDispatchAuthority.ts:46`). A created task can also carry a note-change grant independently of `remember` (`apps/server/src/channels/ChannelReceptionService.ts:1274`), and placement may offer another project when the named one is unavailable (`apps/server/src/channels/ChannelDispatcher.ts:329`). Signatures are verified only when configured (`ScheduledTaskService.ts:1872`).

## Decision D1 (decision.request before B)

Recommendation: an event trigger may start **new work only**, in the trigger's own project, under a **revocable trigger grant** held by the person who created it and **re-checked at dispatch**; every work trigger requires a verified signature. It cannot steer, stop or answer existing work and cannot touch notes; timer check-ins stay answer-only. Options: (a) recommended; (b) event runs answer only; (c) defer triggers.

## Change

1. **Contract** (`packages/contracts/src/scheduledTask.ts`): a bot routine may use the existing `webhook` schedule with `routineMode: "work"` (absent = `check_in`). A `work` routine requires a project and a signature configuration for every preset including **Any webhook**. It may be **saved paused** with the signature required and its secret not yet set (`signature: { required: true, secretSet: false }`), which is how 060 templates and 100 imports create it; enabling it requires the secret (checked on both the upsert and enable paths, `ScheduledTaskService.ts:1079`, :1145), and admitting work always requires a verified signature. New fields are optional, and an older writer that round-trips the record keeps them.
2. **Admission and settlement** (`apps/server/src/scheduledTasks/ScheduledTaskService.ts:640`, :1595): the existing transaction that records a firing and its routine input carries the **rendered, fenced prompt** and the webhook delivery id instead of the saved template. For bot routines the webhook runner does not settle the firing (`cleanupDelivery`, :1595–1643); channel intake owns settlement. Intake's completion rule (`ChannelRoutineIntake.ts:187`) changes for `work` inputs: the firing completes when the started task ends, or when reception replied without starting work; "the inbox replied" alone no longer means done.
3. **Authority**
   - `channelDispatchAuthority.ts` `requesterForDispatch`: for a schedule-origin task, re-read the trigger owner's current grant and intersect, as Slack does; a revoked or reduced grant, or a paused or deleted trigger, refuses the dispatch with a visible task error.
   - `channelRoutineInputs.ts` `routineDecision`: for `work`, allow only "start a task"; strip `remember` and `notesChangeRequested`; every other action becomes a reply.
   - Placement: a schedule-origin task is pinned to the trigger's project; when that project is unavailable the task fails with a reason instead of offering others (`ChannelDispatcher.ts:329`).
   - `ChannelRuntime.ts:280`: `work` inputs stay on the reception path (explicit action allowlist), never the bot's tool session.
   - Create, edit, enable, rebind, rotate and URL disclosure of a `work` trigger are person-only: extend `scheduledBotRoutines.ts` `checkUpsert` to update and enable, and refuse the MCP schedule update path from unbinding or rebinding a bot routine (`apps/server/src/mcp/OrchestratorMcpService.ts:1866`).
4. **Own-work exclusion**: new `apps/server/src/channels/channelRoutineOwnWork.ts`. Provenance is durable before any PR exists: when the bot launches a worker, the task records the repository and head branch it works on. A `pull_request`, `check_suite` or `check_run` delivery is filtered when its repository-qualified head (`owner/repo` + branch) or PR (`owner/repo#number`, `channelBotRowPullRequests.ts:37`) matches this bot's work. A delivery whose head uses GOAT's bot branch prefix but matches no recorded work is filtered **fail-closed** ("possibly the bot's own work"). A check event that names no pull request is **Filtered: no pull request** unless the trigger opts in. Each exclusion is logged in Deliveries with its reason.
5. **Web/desktop**: Home **Routines** (`apps/web/src/components/goatBot/GoatBotRoutines.tsx`) gains **New trigger**: presets **Pull request opened**, **Check failed**, **Any webhook**, a project picker, the URL with Rotate (revealed only to people with settings access), required signature setup, filters (`ScheduledTaskWebhookFiltersField.tsx`). Trigger rows show "On webhook" and pause/resume.
6. **Mobile**: `MobileBotRoutines.tsx` lists trigger rows with pause/resume and how deliveries reach them; creation stays on web/desktop, as signature setup does today.
7. **Agents**: scheduled-task tools may list triggers; they cannot create, edit, enable or rebind `work` triggers.
8. **Docs**: `docs/user/goat-bot.md` Routines; link from `docs/user/project-settings.md` Webhook automations.

## Tests (failing first)

- `apps/server/src/scheduledTasks/ScheduledTaskService.botRoutine.test.ts`: person creates a `work` trigger; a paused draft without a secret saves but cannot be enabled through upsert or enable until the secret is set; an enabled one without a secret cannot exist; agent create, update, enable and rebind are refused. For each of immediate, coalesced and restart-recovered deliveries: exactly one routine input, one task and one settled receipt; a replay adds zero tasks.
- `apps/server/src/channels/ChannelRoutines.test.ts`: a `work` input that starts work creates one task pinned to the routine's project; an unavailable project fails with a reason; steer/stop/answer become replies; the created task carries no note-change grant; a `check_in` input is unchanged.
- Authority: owner's grant revoked after admission → dispatch refused; trigger paused after admission → queued input refused.
- New `apps/server/src/channels/channelRoutineOwnWork.test.ts`: own work filtered by launch-recorded head when the webhook arrives **before** the PR link is projected; same branch name in another repository not filtered; unmatched bot-prefixed head filtered fail-closed; check event without a PR filtered with its reason.
- Mixed version: an older-shaped upsert that omits `routineMode` does not clear it.
- `apps/web/src/components/goatBot/GoatBotRoutines.browser.test.tsx` (existing): New trigger → Pull request opened shows project, URL and required signature; saving lists "On webhook".

## Acceptance

1. From a bot's Home a person creates a signed "Pull request opened" trigger for a project; a signed sample delivery makes that bot start one task in that project, visible in Home, and the run settles when the task ends.
2. Unsigned, duplicate and own-work deliveries start nothing and show in Deliveries with their reason.
3. Revoking the owner's access or pausing the trigger before dispatch stops the queued run with a visible reason.
4. Timer routines behave exactly as before.

## Verification floor

Focused tests above; `vp run check:changed`; independent review lane. Before merge: web/desktop capture of creating a trigger and the task a signed `curl` delivery starts; iOS simulator and Android emulator capture of the trigger row with pause.
