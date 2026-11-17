BLOCK bc3adecde6ab03ec3242b31e69aecc7c324f6b54

I'm blocking this head because of one finding. The #3581 fix leaves some scheduled tasks bound to a deleted or archived thread, and once that happens every later run of the task fails. Before this lane those same tasks recovered on their own: the next run started a new thread. Everything else held up, including fail-first: I reproduced the failing tests myself, and the remaining issues are P3.

`git ls-remote` showed `bc3adecd` at the start and at the end of the review, so the head did not move. The integration head `e04442e66c` is an ancestor of it.

## Findings

**P1. #3581: the startup bind ties a task to a deleted or archived thread for good, and the cleanup it relies on crashes at startup.**

- **Where:**
  - `apps/server/src/scheduledTasks/ScheduledTaskService.ts:960` runs the startup bind loop. The loop calls `bindThread` (`:555`), and `bindThread` calls `deleteForThread` at `:564`. But `deleteForThread` is only declared at `:1246`, later in the same layer body, so at startup it does not exist yet.
  - `firstRunBinding.ts:23` selects the tasks to bind. It accepts any unbound one-thread task that has a retained firing, and it does not skip deleted or archived threads.
- **Trigger, two ways:**
  - **Crash case:** the server stops before a task's first bind (the case the issue is about), and the person deletes or archives that first thread before the next restart.
  - **Mode switch, the more likely way:** a task that ran as "New thread each run" is switched to "One thread" mode, then the server restarts before the task's next run. The upsert at `:499-503` stores `thread_id NULL`, and `created_at` does not change. So the old firings still match, and at restart the task is bound to a thread from its new-thread days.
- **Consequence, from a probe I ran in the scratch copy against the lane's code** (a new-thread task with two runs, switched to `continue`, then the server restarted):
  - The task got bound to an old new-thread thread (`…:1000:manual`), while the person's settings screen still says "The first run starts a thread…".
  - When that thread was deleted, the cleanup threw `ReferenceError: Cannot access 'deleteForThread' before initialization`. I surfaced it by temporarily turning the `catchCause` into a `die`. The `catchCause` swallows it and logs only "Could not bind a scheduled task to its first thread." By then the `UPDATE` has already committed, so the task stays bound to the deleted thread and is never removed. The record's statement that "the task disappears" does not hold at startup.
  - Every later run then fails as "Could not dispatch schedule task.":
    - For a deleted thread, `sendBound` gets `ThreadManagementThreadNotFoundError`.
    - For an archived thread, `ThreadManagementService.ts:1478` raises `ThreadManagementThreadArchivedError`, and `sendBound` does not catch it.
  - The lane's test never covers the deleted path: its mock `getThreadShell` always returns `deletedAt: null`.
- **Smallest fix:**
  - Run the startup bind after `deleteForThread` is defined (or declare `deleteForThread` before `bindThread`).
  - In `firstRunBinding.ts`, skip threads that are archived or deleted, and skip firings from before the task's last edit, for example by requiring `r.requested_at >= t.updated_at`, or by recording the thread mode on each firing.
  - Add tests for a deleted first thread and for a task switched from new-thread mode.
- **Basis:** run (probe) and read.

**P3 (record).** The record says `holdsQueue` is "already stripped on the wire". It is not. The contracts test at `orchestrationV2.interruptRequest.test.ts:39-45` keeps the field through the wire codec; older clients drop it only because their schema has no such key. Behaviour is fine; the record line should be corrected. Basis: read.

**P3 (record).** The record says "no tool resumes a queue". Agents do have one: `queue.resume` in the agent surface (`entries/lifecycle.ts:29`, `ThreadLifecycleMcpService.ts:145`). With this lane, an agent's Resume also ends a person's Stop hold on that thread. That matches what Resume means, but it is missing from the record's list of things that clear a hold. Basis: read.

**P3 (#3569).** The drain's cleanup in `RemoteDispatchCoordinator.ts:896-908` checks the owner, waits on `load(id)`, then deletes the owner without checking again. Meanwhile `start` sets the owner at `:891` without taking the lock. It is safe today because every way a row goes back to running holds that same lock, so a drain started during the wait is for a row that is no longer running. Re-checking `owners.get(id) === owner` after `load` would make it safe without depending on that. Basis: read.

**P3 (#3558).** The runtime-mode refusal fires if any live session on the thread cannot switch mode in-session while any run blocks (`Orchestrator.ts:3057-3085`). It does not look at which session the blocking run uses, so an idle live session left over from another provider would refuse a mid-turn change on Codex. That over-refuses rather than lets anything through, and the two existing refusals behave the same way. Basis: inferred.

**P3 (mobile, #3656).** The queue sheet's Resume now does nothing, with no feedback, when the thread shell is not loaded (`ThreadQueueControl.tsx:287`). Basis: read.

**P3 (docs).** `permission-modes.md` says GOAT "keeps a mode change until the turn ends". On web the server refuses the change and the person sends again. Basis: read.

## What checks out

**#3656 (Resume applies the composer's modes).**
- **Entry points:**
  - On web, every Resume goes through `onResume`: the button, Enter on an empty composer at `ChatComposer.tsx:2137`, and `:3607`.
  - `QueuedRunsControl`'s only use of `resumeThreadQueue` passes a `runId`, so it is Send now.
  - On mobile, the composer and the queue sheet both go through `saveComposerModes`, which saves the modes and then resumes.
- **Refusal:** a refused mode change resumes nothing and shows the refusal.
- **Send now:** unchanged on both clients.
- **Tests:** they failed on the base, and pass at head.
- **One addition:** on the no-run branch, web Resume now also saves the branch fix-up. It uses the same helper as a send.

**#3653 (C4, late decline after Resume).**
- **Same commit:** the release runs after the `switch` in `dispatchOnce` (`:12623`), so its events commit with the command. A refused or failed command writes nothing.
- **No double write:** replaying a receipt does not run `dispatchOnce`, and the test confirms the stored events are identical.
- **Ordering:** the decline's follow-up is itself a `message.dispatch` on the same thread lock (`EffectWorker.ts:302`), so it lands either before or after the Resume command, never in the middle.
- **Scope:** only that thread's items are rewritten, and the projection upsert replaces the whole payload, so the flag is gone afterwards.
- **What does not clear a hold:** an ordinary send and Send now leave it, as the coordinator ruled.
- **Older servers and clients:** they read the rewritten item as not holding the queue.

**#3558 (C4, mode change during a turn).**
- **Typed guard:** the receipt step checks `_tag` plus the `refusal` field (`:12742`), with no text match.
- **Wire:** my encode probe of the error clients receive gives `cause: {name, message, cause}` with no `refusal` field.
- **Nothing committed:** a refusal leaves no events, projection change, outbox effect or receipt, and the same command id succeeds once the turn ends, then replays as success. The test covers all three refusals.
- **Fixed-id senders:** I checked the sender list. The phone outbox's runtime-mode, interaction-mode and compact steps are the only fixed ids. GOAT Bot's id includes a timestamp, no MCP tool sends these commands, and the worktree senders carry `expectedWorktreePath`.
- **Session state:** idle, stopped and errored sessions are not refused.
- **Web redirect:** when the mode is unchanged, the calls are the same and in the same order as before.
- **React Compiler:** the coverage test passes.
- **Phone:** the row reason is set on refusal and cleared on delivery, and the retry backoff code is unchanged.

**#3581 (scheduled task crash before the first bind).**
- **Normal path:** a crash before the first bind now leaves one thread, and a task that is already bound is never rebound.
- **Restarts:** repeating the restart is harmless.
- **Startup cost:** small; runs are pruned and the lookup is indexed by task.
- **Exception:** P1 above.

**#3568 and #3569 (remote dispatch).**
- **Locks:** `KeyedLock` gives the same per-key exclusion as the old per-row semaphores and drops a key once no one holds or waits for it.
- **Owners:** a row that is still running keeps its owner.
- **Notice:** sent once per failure streak, with a key that includes the streak's start; a failure inside the notice only logs; a good pass resets the count.
- **Test reader:** `heldAfterDrains` is off the service shape. It is still a module export, read-only.

**#3641 (notes stay in Doing).** Completion is now judged by run id, status and outcome, so an equal re-read no longer blocks it, and a newer run still blocks it. No existing test changed.

**#3639 (failed thread read).** A failed read logs one warning carrying only `_tag`; a missing thread stays silent.

**Move-out commits.** All are verbatim except for `export` keywords, imports and call sites:
- `a4cba315de` wraps the same read expression in `readPreparedThread`.
- `6a1c6d7812` turns a closure into a helper with parameters.
- `69b4f1605e` is a small refactor rather than a pure move.

**Rule 3 (no changed test expectations).** No pre-existing `assert` or `expect` line changed. Only imports changed, plus the one testkit re-export.

**Budgets and rules.**
- Every budget entry equals the file's real length, and none was raised.
- `Orchestrator.ts` is 13528, its entry. `NotesService.ts` went from 993 to 1000.
- No new non-null assertions, `any`, sleeps or timeouts outside tests.
- The span name is `Orchestrator.releaseStopHolds`.

**Lane merges.** `d4a8ccc5ec` and `daadbb8a3e` each equal `merge-tree`'s result for their parents. Files changed on both sides: none for the first, `code-budgets.json` only for the second, which merged cleanly.

**Author claims I re-ran.**

| Check | Result |
|---|---|
| Server: the 7 new test files | 57/57 pass |
| Server: 31 existing files beside the changes | 455/455 pass |
| Web | 6 files, 1975 tests pass |
| Mobile | 4 files, 61 tests pass |
| Fail-first, base sources swapped in | the 12 regression tests failed, the guard tests passed |

## Merge state

- **Integration head `e04442e66c`:** an ancestor, so the merge is clean.
- **dev `78387154`:** conflicts in `ThreadWorkspaceService.ts` and its `setupTerminal` test. The integration head alone has the same conflict, so it is inherited, not the lane's. The lane's only file touched on both sides is `code-budgets.json`, which merges cleanly.
- **`n12b-followups` `2c0e5563`:** clean, with no files touched on both sides.
- **`n14-web` and `n15bb-followups`:** not on origin. `n15b-mobile` is already inside the integration head.

NOT RUN:
- **CI:** goat-ci 44107240497 had not finished. As of 15:10Z, 8 jobs were green, including `goat-check`, and 17 were pending, including the server shards, typecheck and `test-changed`.
- **Not run locally:** typecheck, lint, and the wide test selection that `check:changed` picks.
- **Fail-first on web, mobile and remote dispatch:** not re-run; for those I am relying on the author's record.
- **Not tried at all:** phone captures, the desktop shell, real provider turns, a live remote dispatch, a real scheduled-task crash, and the web captures.

My scratch copy is at `/tmp/sf1-review-bc3adecd` (816M, with `node_modules` borrowed from the `chase-t3-261114-next2-n-bd1af2b5260ef634` worktree). It holds my two probe tests, `apps/server/src/scheduledTasks/ScheduledTaskService.reviewProbe.test.ts` and `apps/server/src/reviewProbe/wire.reviewProbe.test.ts`.

BLOCK bc3adecde6ab03ec3242b31e69aecc7c324f6b54
