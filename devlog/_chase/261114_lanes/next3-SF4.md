# SF4 · goat#3581 · C4 plan

Base 2c0e0002a996ec5d46c708919be5a43f579176fa, integration PR #3700, juns-MacBook-Pro. GOAT's earlier candidate (0f230389b94) was reverted (410daab8e64). ScheduledTaskService.ts still binds after launch; ScheduledTaskRuns.ts startup reconciliation only settles the firing. SF1F-P1-1 rules out inferring a destination from historical firings.

T3 Code still binds in a post-launch tap and logs a failed bind after the run has been accepted. GOAT already commits the run projection and exact firing together in EventSink; put the bind at that boundary so success means both the first run and its destination are durable. [Upstream 4aab23cd72](https://github.com/pingdotgg/t3code/blob/4aab23cd72/apps/server/src/scheduledTasks/ScheduledTaskService.ts#L829-L849), [GOAT EventSink](https://github.com/goat-si/goat/blob/2c0e0002a996ec5d46c708919be5a43f579176fa/apps/server/src/orchestration-v2/EventSink.ts#L207-L237).

- Schema. Migration 158 ScheduledTaskFirstBindIntent adds nullable first_bind_project_id to scheduled_task_runs, with no backfill. GOAT's current max is 157; the pinned upstream head 8a6342e7613 and the fetched upstream main 37e9217b5696f33f347cdd282830e897a04c10ab both stop at 098. Register the name in GOAT_MIGRATION_NAMES so future upstream allocations can shift it by name. Tell integration to shift 158 with the existing block if it imports the upstream 090–098 ledger.
- Admission. A fresh or retried webhook firing captures the project only for an unbound one-thread launch. Match the dispatch snapshot against the persisted task identity, project, mode and null thread inside the admission transaction. Clear pending intent when a task moves project or switches to new_thread, including a switch away and back before acceptance. Destination-neutral edits and continue/fresh_session switches preserve intent. A failed attempt consumes intent and a retry recomputes it.
- Commit and recovery. Bind in ScheduledTaskRuns' existing acceptance transaction once the firing's exact durable first message and run match, guarded by task id, creation time, current firing id, project, unbound one-thread destination, and a live unarchived same-project thread. A SQL failure rolls back initial-message acceptance with the binding. A crash after acceptance leaves both durable; a crash after thread creation but before its initial message may leave an empty thread, with no accepted run and no inferred binding. Reconciliation uses the same acceptance path, so no search through terminal history. Runtime deleted-thread cleanup remains after launch; startup does not delete tasks.
- Compatibility and rollback. Web/desktop/mobile clients, RPC and MCP keep the existing scheduled task/run payloads in both version directions. New server upgrades an older database and treats all existing firing intents as null. The old writer uses named columns and reads its existing receipt JSON, and the old runner's noncolliding unknown-ledger warning path needs verification on a fixture. Roll back the executable while retaining the additive column and ledger row where the preceding build accepts them; if downgrade requires restoring a pre-upgrade snapshot, use the normal backup and account for writes since it was taken. An interrupted migration rolls its schema and ledger back together. No production DB access.
- Verification. In ScheduledTaskService.threadMode.test.ts hold a launch on a Deferred after the actual EventSink commit and before its return; demonstrate the accepted thread already binds, and after service restart the next occurrence uses it. Retain the existing deletion guard. Cover inactive intent, archived/deleted thread, stale destination or replacement, and failed bind at the commit boundary. Verify upgrade/idempotence, older row and writer compatibility, and the migration-ledger suites. Use the full affected test files from apps/server with GOAT_TEST_TMP_GUARD=fail, then check:changed against the integration ref after merging it once. No P1 dev server in this lane.

Newer upstream scheduler touches, left to their lanes: 281d3e1cbe9 (manual paused one-time), 17c142588b0 (delete one-time task on completion), 4a3be943c91 (refusal reasons), 3ceed620cfc (non-Git project workspace). Compare older event/persistence paths again at handoff.

## SF4 handoff · BLOCKED

| Row | Verdict | Lane commit |
| --- | --- | --- |
| goat#3581 | GOAT-authored C4 fix implemented. Gate blocked on approval to update existing migration-ledger assertions. | c776171a80c6991ef0dbdb959793da4de3b99ed4 |

Pushed chase/t3-261114-next3-sf4 at c776171a80c6991ef0dbdb959793da4de3b99ed4. The integration ref was still the branch's direct parent 2c0e0002a996ec5d46c708919be5a43f579176fa at handoff. The final integration merge is pending READY. GOAT-authored range 2c0e0002a996ec5d46c708919be5a43f579176fa..c776171a80c6991ef0dbdb959793da4de3b99ed4. Clean upstream picks: zero.

### Checks

- Baseline with the five regressions added: from apps/server, GOAT_TEST_TMP_GUARD=fail vp test run src/scheduledTasks/ScheduledTaskService.threadMode.test.ts exited 1 with 5 failing and 10 passing. Both one-thread modes were unbound after acceptance, an injected bind failure left an accepted run, and a mode or project change away and back allowed a stale bind.
- Final focused run from apps/server: GOAT_TEST_TMP_GUARD=fail vp test run --reporter=default with the six whole files below exited 0, 124 passed, zero failures or skips.
  - src/scheduledTasks/ScheduledTaskService.threadMode.test.ts — 18
  - src/scheduledTasks/ScheduledTaskRuns.test.ts — 13
  - src/scheduledTasks/ScheduledTaskService.test.ts — 8
  - src/scheduledTasks/ScheduledTaskService.webhook.test.ts — 54
  - src/scheduledTasks/ScheduledTaskService.botRoutine.test.ts — 13
  - src/orchestration-v2/ScheduledTaskOutcomes.integration.test.ts — 18
- From apps/server, vp run typecheck exited 0. From root, vp run check:changed origin/chase/t3-261114-next3 exited 1 after 232 selected files: 226 passed, 4 failed, 2 skipped, 2770 tests passed, 20 failed, 4 skipped. Rename check, format, lint, both Knip passes, GraphQL, agent surface audit, agent context budget and both package typechecks passed. The commit hooks briefly reran format and lint while the gate's tests were active.
- All 20 failures are in existing ledger assertions. Rule 3 of next3-plan.md reserves those edits. Requested scope: reconcileV2PreviewMigration.test.ts appends 158 to two exact upgrade lists. reconcileGoatMigrationIds.test.ts updates the manifest tail from 157 to 158. reconcileGoatMigrationIds.upstream080.test.ts updates current/shifted tails from 157/167 to 158/168 and expects 158 after resumption, with the intermediate pre-089 fixture still capped at 157. reconcileGoatMigrationIds.resume.test.ts keeps the historical injected crash and partial ledger pinned to 157, expects 158 in post-resume lists, and updates the current-ledger diagnostic from 157 to 158. The focused run of these files plus Migrations.test.ts, Migrations.databaseAhead.test.ts and ScheduledTaskOutcomes.integration.test.ts exited 1 with 114 passed and the same 20 failures. Approval was requested and remains pending.

### Implementation and compatibility evidence

The bind now commits in the EventSink transaction that accepts the initial scheduled message and writes the run. The firing carries the eligible project from admission and drops its intent on an incompatible destination edit. The bind checks the current firing, task incarnation and live thread projection. Archived, deleted, replaced or stale destinations cannot acquire a binding. A failed binding SQL write rolls back the accepted message and run. The real launch creates its thread in an earlier command, so a crash or refusal before initial-message acceptance can leave an empty thread. No historical firing is backfilled.

Migration 158 is idempotent even when replayed outside its ledger. A fixture made the trigger creation fail after column creation and verified that the SQLite transaction rolled back both the column and ledger row, then retried successfully. A Node 26.12.1 in-memory compatibility probe loaded the actual 2c0e0002a996 migration runner and firing store alongside the new versions. It read pre-upgrade data on the newer code, reopened and read a new firing on the older code, and wrote a legacy firing after downgrade. The older runner logged only its unknown-158 warning and exited 0. The newer runner subsequently had no further migration to apply.

### Newer range handoff

- Scheduler: 281d3e1cbe9, 17c142588b0, 4a3be943c91, 3ceed620cfc.
- EventSink: 733a20008c7, 4b99420d8e1.
- ThreadLaunchService: 4ffa1da7cfe, 1adc05b8445, e00614e126c, fb749693143, dfd2187ccb0, c924d7898fb, 3ceed620cfc, 719042d9425, 4bab2f3ae71.
- Migration manifest: 980f5d41286, 86863beedef, 4da2bc520c3, f5d86e31e82, 4f829644f66, a62bc8156da, 3e176182122, e5c636219c7, a2edd281df2. Recheck GOAT's shifted block if bringing in upstream 090–098.

P1 for #3581: use Replay in a scratch project. Open an automation set to one thread, run it, restart GOAT, and run it again. The two run links should open the same thread. In the fresh-session mode the second run opens a new provider session in that thread. A new-thread automation still gives separate threads.

NOT RUN: final integration merge, rerun after ledger assertion updates, P1 real-client pass, lane CI, independent review, repository-wide checks.

## 2026-11-18 ruling follow-up · BLOCKED

The coordinator approved the migration 158 assertion changes in the four existing suites and reserved all setup and title changes. SF4 owns migration 158. The coordinator will allocate upstream 092–098 after 158.

The new local commit is c6e1e7fc3bf553ec569c4de04c463dc258e25ac2. The published lane head remains c776171a80c6991ef0dbdb959793da4de3b99ed4. `git fetch origin` and `git merge origin/chase/t3-261114-next3` both exited 0. The merge reported `Already up to date.` at integration tip 2c0e0002a996ec5d46c708919be5a43f579176fa.

The in-memory and on-disk instances of `a kill inside the ledger move leaves the old ledger whole` still fail. The fixture seeds the historical ledger through 147. Its unchanged `killWhenRecording(goatNames.at(-1) ?? "")` now resolves to `ScheduledTaskFirstBindIntent`, after the ledger move. Pinning it to `killWhenRecording("DisposableMachineEnrollment")` would retain the original injected failure at the ledger-move transaction. Approval for that one source line is pending.

- From `apps/server`, the four full persistence files with `GOAT_TEST_TMP_GUARD=fail vp test run --reporter=default` exited 1. 102 passed and 2 failed. `reconcileGoatMigrationIds.resume.test.ts` 48/50, `reconcileGoatMigrationIds.test.ts` 33/33, `reconcileGoatMigrationIds.upstream080.test.ts` 14/14, `reconcileV2PreviewMigration.test.ts` 7/7.
- From `apps/server`, the six full scheduler and outcome files listed above with `GOAT_TEST_TMP_GUARD=fail vp test run --reporter=default` exited 0. Thread modes 18/18, firing store 13/13, service 8/8, webhooks 54/54, bot routines 13/13, outcome integration 18/18. Format and lint hooks passed after the test commands completed.

Limits: A crash before initial-message acceptance can leave an empty thread because thread creation commits earlier.

NOT RUN: changed-files gate rerun pending the crash fixture ruling, lane push for this follow-up, P1, lane CI, independent review, repository-wide checks.

### Rule 3 assertion quotes

The table quotes the changed expected operand at each assertion in the four files under `apps/server/src/persistence/`. Line numbers refer to c776171a80c, before the update. The preview migration arrays are quoted at their tail. The diagnostic row quotes the string the parameterized assertion expects.

| File and original line | Before | After |
| --- | --- | --- |
| `reconcileGoatMigrationIds.resume.test.ts:252` | `goatNames.map(currentRow)` | `goatNames.map(currentRow).filter(([id]) => id !== 158)` |
| `reconcileGoatMigrationIds.resume.test.ts:257` | `UPSTREAM_80S.slice(1)` | `[...UPSTREAM_80S.slice(1), [158, "ScheduledTaskFirstBindIntent"]]` |
| `reconcileGoatMigrationIds.resume.test.ts:274` | `UPSTREAM_80S.slice(3)` | `[...UPSTREAM_80S.slice(3), [158, "ScheduledTaskFirstBindIntent"]]` |
| `reconcileGoatMigrationIds.resume.test.ts:295` | `UPSTREAM_80S.slice(5)` | `[...UPSTREAM_80S.slice(5), [158, "ScheduledTaskFirstBindIntent"]]` |
| `reconcileGoatMigrationIds.resume.test.ts:361` | `goatNames.map(currentRow)` | `goatNames.map(currentRow).filter(([id]) => id !== 158)` |
| `reconcileGoatMigrationIds.resume.test.ts:366` | `UPSTREAM_80S.slice(1)` | `[...UPSTREAM_80S.slice(1), [158, "ScheduledTaskFirstBindIntent"]]` |
| `reconcileGoatMigrationIds.resume.test.ts:381` | `highest recorded id (157)` | `highest recorded id (158)` |
| `reconcileGoatMigrationIds.test.ts:576` | `[157, "DisposableMachineEnrollment"]` | `[158, "ScheduledTaskFirstBindIntent"]` |
| `reconcileGoatMigrationIds.upstream080.test.ts:39` | `[157, "DisposableMachineEnrollment"]` | `[158, "ScheduledTaskFirstBindIntent"]` |
| `reconcileGoatMigrationIds.upstream080.test.ts:83` | `[currentRow("DisposableMachineEnrollment")]` | `[currentRow("DisposableMachineEnrollment"), [158, "ScheduledTaskFirstBindIntent"]]` |
| `reconcileGoatMigrationIds.upstream080.test.ts:176` | `migrationManifest.filter(([id]) => id !== 89)` | `migrationManifest.filter(([id]) => id !== 89 && id !== 158)` |
| `reconcileGoatMigrationIds.upstream080.test.ts:185` | `UPSTREAM_80S.slice(-1)` | `[...UPSTREAM_80S.slice(-1), [158, "ScheduledTaskFirstBindIntent"]]` |
| `reconcileGoatMigrationIds.upstream080.test.ts:197` | `UPSTREAM_80S` | `[...UPSTREAM_80S, [158, "ScheduledTaskFirstBindIntent"]]` |
| `reconcileGoatMigrationIds.upstream080.test.ts:252` | `[167, "DisposableMachineEnrollment"]` | `[168, "ScheduledTaskFirstBindIntent"]` |
| `reconcileV2PreviewMigration.test.ts:174` | `[157, "DisposableMachineEnrollment"]` | `[157, "DisposableMachineEnrollment"], [158, "ScheduledTaskFirstBindIntent"]` |
| `reconcileV2PreviewMigration.test.ts:356` | `[157, "DisposableMachineEnrollment"]` | `[157, "DisposableMachineEnrollment"], [158, "ScheduledTaskFirstBindIntent"]` |
