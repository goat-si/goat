APPROVE WITH NITS 410daab8e64288542fef65ba97e078d507e6c8fd

All five fixes do what the coordinator ruled, and every earlier finding is closed. The narrowed refusal for permission-mode changes cannot let through a change that would end a running turn. I found no P0 to P2 issues. There are two P3 nits, both on the narrowed refusal: its code and commit message describe a check that never actually runs, and it lacks a test for the "still refused" direction.

The remote head was 410daab8 at the start (16:06:57Z) and at the end (16:19:40Z). The integration branch moved during the review, from ce893ca4 to 3a254fa1; merge state against both is below.

## Findings

**P3-A (goat#3558): the provider-thread match in `endsTurn` never runs, so the check matches by provider instance only.**

- **Where:** `apps/server/src/orchestration-v2/goat/ActiveTurnRefusals.ts:47-67`.
  - `Orchestrator.ts:3015` asks for the provider context without an instance for `thread.runtime-mode.set`.
  - Without an instance, both versions of `getThreadProviderContext` return `providerThreads: []` (`ProjectionStore.ts:4813` and `:8396`).
  - So `sessionId` is always `undefined`, and every run falls through to `session.providerInstanceId === run.providerInstanceId`.
- **Trigger:** any permission-mode change.
- **Consequence today:** only the safe direction. Instance matching covers more cases than session matching would.
  - Probe 6 shows the context really has no provider threads.
  - Probe 4 shows that an idle, non-switching session of the run's own instance refuses a turn running on a different, switching session.
  - The code comment and the commit message ("refuses only when a blocking run's provider thread is on one of the sessions the change releases") describe matching that does not happen.
- **Latent risk:** if a later change loads provider threads for this command, the branch starts running. `providerSessionId` can be null (`packages/contracts/src/orchestrationV2.ts:1094`), so `session.id === null` never matches, and a change that ends that run's turn would go through.
- **Smallest fix:** drop the provider-thread lookup and the `context` parameter, match on `run.providerInstanceId`, and say so in the comment. If the lookup stays, treat `null` like `undefined` and add a test whose context includes provider threads.
- **Basis:** RAN (probes 4 and 6) and READ.

**P3-B (goat#3558): no lane test covers the "still refused" direction of the narrowed rule.**

- **Where:** `Orchestrator.activeTurnRefusals.test.ts:430`. The new test only covers the case that is now allowed.
- **Gap:** no test checks that a run without a provider thread (preparing, starting or waiting) is still refused, or that a turn on a non-switching session is refused while an idle session of another instance sits beside it.
- **Consequence:** a later edit to `endsTurn` could stop refusing these runs and no test would fail.
- **Smallest fix:** move my probes 1 and 2 into the file. They pass at the head and on the parent.
- **Basis:** RAN.

## What checks out

**SF1F-P1-1, closed.**

- **Source match:** `ScheduledTaskService.ts` at the head is byte-identical to c4df7ffd5e (empty `git diff`). The whole `scheduledTasks` folder also matches c4df7ffd5e. Against e04442e66c, the file differs only by the move-out: one import block added, and the JSON schema helpers and the `WebhookDeliveryRow` interface removed. (RAN)
- **Verbatim move-out:** `webhookDeliveryRow.ts` is verbatim. Its sorted lines, minus `export ` and the import, equal the removed lines (diff exit 0). (RAN)
- **Startup bind gone:** `firstRunBinding.ts` and its test file are gone, and nothing imports them. `rg` for `unboundFirstRunThreads|firstRunBinding|firstRunBind` finds nothing. (RAN)
- **`bindThread`:** it now runs only on its runtime path, as at e04442e66c, so the startup crash on `deleteForThread` cannot happen. (READ)
- **Budget and issue:** the budget entry is 2256 and the file has 2256 lines. goat#3581 is OPEN. (RAN)
- **Tests:** the scheduled-task folder passes, 18 files and 178 tests. (RAN)

**SF1F-P3-4, closed apart from the P3s above.**

- **What a mode change releases:** every live session on the thread that cannot switch modes in session, not just one (`Orchestrator.ts:3047-3067`). It emits a detach event and a detach effect for each (`:3834-3870`). (READ)
- **How each kind of blocking run is decided:**

| Run | Result | Basis |
|---|---|---|
| Running turn on a released session | Refused, including beside a switching or non-switching session of another instance | Existing test, probes 1 and 1b (RAN) |
| Preparing, starting or waiting run with no provider thread, instance matches a released session | Refused | Probe 2 (RAN) |
| Same run, but only another instance's session is released | Accepted, which is correct: that session is not the run's | Probe 3 (RAN) |
| Two blocking runs, one matching | Refused | Probe 5 (RAN) |
| Restart or continuation run | Covered. The run's instance moves with a steering restart (`:4976`), and its session opens on that same instance (`ProviderSessionManager.ts:1560`, `:2687`) | INFERRED |
| Run being recovered on a new live session | Refused, matched by instance | INFERRED |
| Subagent | Native subagents are nodes inside the run, on the same session | INFERRED |

- **Can the narrowing end a running turn?** I found no way. That holds as long as a run's session carries the run's instance, which the attach path ensures (INFERRED).
- **The idle session of the old provider, released during a Codex turn:**
  - **Background work:** still protected by the check at `:3093-3104`. Claude, OpenCode v1, ACP and Pi probe at the session level (`SessionBackgroundWork.ts:16-19`), so the empty provider-thread list does not blind that check. Cursor and Grok expose no probe.
  - **Pending approval:** it would belong to a blocking run on that session, and the instance match refuses that.
  - **Net effect:** nothing is lost beyond what a mode change on an idle thread already releases. (READ/INFERRED)
- **Fail-first:** with the parent's sources swapped in (57b681dc6a), the new test fails with `refusal: 'active_turn'`, "changing its permission mode would end it", at `:3082`. I restored the sources and checked them with `cmp`. (RAN)
- **Receipts:** the rule is unchanged: the typed check on `_tag` plus `refusal`, with no text match. The test "records no receipt, and the same command id succeeds once the turn ends" now exercises the runtime-mode case through the instance match and passes. (RAN)
- **Provider-switch and worktree refusals unchanged:** for every other command type, `endsTurn` returns `blocking.length > 0`, which is the old `runs.some(isBlockingRun)`. `refusalText` is untouched. The file passes, 23/23. (READ/RAN)

**SF1F-P3-3, closed.**

- **Lock:** both reads of `owners` happen under `locks.withLock(id)` (`RemoteDispatchCoordinator.ts:903-904`). `start` sets an owner outside the lock, and that is exactly the case the second check catches.
- **No leak:** a replaced drain has no entry of its own left, because the map is keyed by row id and `start` overwrites it.
- **Unchanged behaviour:** a running row keeps its owner, and a failed `load` still keeps it, as before.
- **Tests:** 13 files and 145 tests pass, including mapBounds and drainStreak. (READ/RAN)

**SF1F-P3-5, closed.**

- **Nothing sent:** `resume-thread.ts:124-127` returns a failure before any command is built.
- **Message shown:** the queue sheet's guard at `ThreadQueueControl.tsx:287` no longer returns early, so the failure reaches the existing "Could not resume queue" dialog with the message.
- **Composer path:** the composer's `resumeThread` is unchanged.
- **Fail-first:** the new test fails on the parent with `TypeError: Cannot read properties of null (reading 'interactionMode')` and passes at the head. The two mobile files pass, 18 tests. (READ/RAN)

**SF1F-P3-6, closed.** The paragraph is true. (READ)

- **Web:**
  - A refused mode change puts the message back in the composer, with the server's sentence in the banner.
  - If the person has typed something new since sending, it goes to the prompt stash instead (`useComposerSend.ts:1608-1614`).
  - A send that redirects pending approvals keeps the draft in the composer (`:1270-1281`).
- **Phone:** the outbox sends the runtime-mode step before the message, records the reason, and retries later (`threadOutboxDelivery.ts:200-215`).
- **Codex and Antigravity:** the paragraph says refusals happen only on providers that cannot switch modes. After this narrowing, a Codex turn beside a leftover non-switching session is no longer refused, so the text matches the behaviour.

**Scope and repository rules.**

- **Scope:** the 12 changed files all belong to the five commits' stated purposes. (RAN)
- **Rule 3, test files have additions only:**
  - `Orchestrator.activeTurnRefusals.test.ts` has 0 removed lines against e04442e66c (whitespace ignored).
  - `resume-thread.test.ts` has 1 removed line: an import widened by an earlier lane commit; none this round.
  - The deleted test file did not exist at e04442e66c; the lane added it in 0f230389b9. (RAN)
- **Budgets:**
  - ScheduledTaskService.ts: entry 2256, real 2256.
  - Orchestrator.ts: entry 13528, real 13528; its length did not change.
  - RemoteDispatchCoordinator.ts: entry 1238, real 1238.
  - Nothing was raised. (RAN)
- **New lines:** no sleeps, polling, timeouts, retries, non-null assertions or `any` casts, and no new Effect functions.
- **Lint:** lint on the 8 changed files exits 0. Its 4 comment-length warnings are on lines this round did not touch. (RAN)
- **Typecheck and MCP counts:** `tsc --noEmit` for apps/server exits 0 with 0 errors. The two MCP count tests pass, 43 tests. (RAN)

## Merge state

| Target | Result | Files changed on both sides |
|---|---|---|
| Integration 3a254fa1 (the new head) | Clean | `code-budgets.json`, auto-merged |
| ce893ca4 | Clean | `code-budgets.json`, auto-merged |
| n4c 4fa20e69 | Clean | None |
| n12b 2c0e5563 | Clean | None (already inside 3a254fa1) |
| n14-web 2a94ed4d | **2 conflicts** | `useComposerSend.ts`, `code-budgets.json`, `ThreadFeed.tsx` (auto-merged) |

Neither n14-web conflict comes from this round; both come from earlier lane commits the first review approved. They resolve mechanically:

- **`useComposerSend.ts`:** the conflict is in the import block. The lane dropped the `UnifiedSettings` import and n14-web dropped the `DraftSshDestination` import. Neither name is used anywhere else in the merged file, so both lines go, leaving 1635 lines.
- **`code-budgets.json`:** set each conflicting entry to the merged file's real length, which is lower than either side.
  - `useComposerSend.ts`: lane 1674, n14-web 1636, merged 1635.
  - `ThreadFeed.tsx`: lane 3356, n14-web 3376, auto-merged 3344.

## The author's claims

- **Confirmed by my runs:**
  - The idle session of another instance no longer refuses a mode change, and the new test fails on the parent for that reason.
  - An unclear case still waits: probe 2 refuses a run with no provider thread.
  - The provider-switch and worktree refusals are unchanged.
  - `ScheduledTaskService.ts` differs from the integration head only by the move-out, and its budget went from 2264 to 2256, its real length.
  - The drain re-check and the mobile loading message work as described.
- **Not as described:** the claim that the rule matches a run's provider thread to a session (P3-A).
- **Resting on the author's report:** "a busy session stays up across a provider switch" (`Orchestrator.ts:1418-1419`). I read that queue-start code but did not exercise it.

**CI:** goat-ci 44115576485 ran on exactly 410daab8 and was **cancelled** at 16:14:38Z. No job failed, but `goat-ci-result` is not SUCCESS on this head, and there is no newer run on it.

- **Passed (17):** goat-scope, goat-check, goat-typecheck, goat-build, test-mobile, test-desktop, server 2/4, contracts, shared, client-runtime, relay, pen, pen-windows, windows, ingest, the Linux computer-use smoke test, and the Connect auth PostgreSQL boundaries job.
- **Cancelled (10):** server 1/4, 3/4 and 4/4, goat-test, test-changed, packages, ssh, memory-growth, goat-ci-result, and the republish refresh job.

**Scratch folder:** `/tmp/sf1-review-410daab8`. It is a git archive of the head, with `node_modules` APFS-cloned from `chase-t3-261114-next2-n-bd1af2b5260ef634`, whose lockfile matches (3a4a9b79).

- **Probes:** `apps/server/src/orchestration-v2/Orchestrator.activeTurnRefusals.reviewProbe.test.ts`.
- **Logs and merge output:** `_review/`.
- **Swapped files:** every file I swapped for the parent runs was restored and checked with `cmp`.

NOT RUN: CI to completion on 410daab8 (server shards 1/3/4, goat-test, test-changed, packages, ssh and memory-growth were cancelled); local lint or typecheck of apps/web and apps/mobile (CI's goat-typecheck passed); `check:changed`; a typecheck or tests of the n14-web merge result; real provider turns, a real Claude-beside-Codex thread, phone or web captures, and a live remote drain.

APPROVE WITH NITS 410daab8e64288542fef65ba97e078d507e6c8fd
