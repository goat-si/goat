# L01 retry (Claude), cycle 261114

Lane branch: chase/t3-261114-claude-retry. Round 1 head 637128e1736f (reviewed: APPROVE WITH NITS, merged into chase/t3-261114-all at 24c7a4e0da). Round 2 hands over 9ed11e8829 as a delta on 637128e173. The original L01 PR #3222 is merged; this file is the full record for the retry (no PR body).

Round 1 ported 10 upstream commits: 896e64f82d, 7 of the 10 effort rows (543ee27fa8, 5badea5b45, cdbfae86cd, 458a792087, 86ae1747ad, 7315c60b95, d20d535e32) and the two predecessor rows a50ebef78b and 694076dcf3. The first version of this record said 11; that count was wrong. Round 2 ports the last three effort rows (00766e2c02, c7618f6c10, 9ce9b1fd41) and the two rows whose predecessors round 1 landed (ccc9aaf10b, 7462f234e8). Each port commit ends with one paragraph holding `Upstream:` and `Decision:`.

## Review items

Card line 100 authorised these four (quoted): "L01 재시도(#3222 머지 뒤): 노력 미룸 10개, #3222 리뷰 P3-1(ProviderInstanceRegistry.test.ts:856의 "quarantine: #3176" 대신 일반 주석), P3-5(ClaudeSyncedSkills.test.ts의 t3-claude-skills- 접두사를 goat-claude-skills-로), #3193 리뷰 P3-1(ProviderInstanceRegistry.claudeGrant.test.ts 삭제: b99e2e0810 이후 ProviderInstanceRegistry.test.ts:763, :876-885와 중복), P3-6(ClaudeAdapterV2.ts의 제약 주석 두 줄 복원, PromptRefusal.ts:5-9 보강, 스킬 handoff 회귀 테스트를 ClaudeGoalCommand.test.ts로)."

- **#3222 P3-1:** the Windows skip in ProviderInstanceRegistry.test.ts has a plain comment ("Windows cannot execute the mock CLI script.") instead of "quarantine: #3176" (`db42d7fb88`).
- **#3222 P3-5:** ClaudeSyncedSkills.test.ts temp directories use the `goat-claude-skills-` prefix (`db42d7fb88`).
- **#3193 P3-1:** ProviderInstanceRegistry.claudeGrant.test.ts is deleted; ProviderInstanceRegistry.test.ts covers the selected-grant redemption and unknown-grant rejection (`db42d7fb88`).
- **#3193 P3-6:** the two ClaudeAdapterV2.ts constraint comments are back, PromptRefusal.ts says a query that exits before the turn attaches never offered the prompt, and the handoff skill-mention regression is in ClaudeGoalCommand.test.ts (`1f2efc7152`).

Round 2 coordinator items:

- **steersClosed re-check test** (`3de5f34f62`): ClaudeSteerAcceptance.test.ts holds refreshMemoryContext on a Deferred, stops the turn, then releases it. The steer fails, no `pending` status is emitted and nothing is offered. With the second check removed the test fails (`expected false to be true` on the steer's failure).
- **scheduleWakeupCalls** (`50ba1dc496`): cleared where scheduledWakeupsByNativeThread is cleared on reset and on a stop or process exit. It holds tool use ids only, so there is no visible change and no test.
- **Late `pending` overwriting `completed`**: the two-line ingestor guard is not safe. A steer's user_message item is created `completed` and its first `pending` moves it from completed to pending (ProviderEventIngestor.screenRows.test.ts, "keeps a steered message pending until the provider reports it read"), so refusing completed → pending would hide every waiting badge. Filed as goat#3412 with two fixes (emit pending before registering, or a per-steer sequence).

## Moves for room (no budget raised)

Round 1: `c20d5429af` (query runner to ClaudeAgentSdkQueryRunner.ts), `247e4ad9c5` (fork test), `a1c81ccb62` and `a41b2b3a5d` (wake frames testkit), `f84036007a` (lowered this lane's three budgets to their lengths).

Round 2, each in its own commit before the port that needed it; a script compared every moved line with the original:

- `ba79236d7a`: Claude tool classification, tool input and output, tool result and background task frame helpers (667 lines) to ClaudeToolFrames.ts. Zero line mismatches; the names the adapter uses are listed in one export block at the end of the new module.
- `feea042f19`: release reason schema and session manager errors (79 lines) to ProviderSessionManagerErrors.ts, re-exported from ProviderSessionManager.ts. Zero mismatches.
- `3ffe83a6a7`: the "ClaudeAdapterV2 attachments" describe (599 lines) to ClaudeAdapterV2.attachments.test.ts. Zero mismatches; the file carries its own resolveSettings mock.
- `b12342a720`: the "PiRpc framing" describe (70 lines) to rpc.framing.test.ts. Zero mismatches.
- `282934730a`: provider maintenance runner fixtures (238 lines) to providerMaintenanceRunner.testkit.ts. Zero mismatches.
- `be1a87fbfb`: commandThreadId (84 lines) to orchestratorCommandThreadId.ts. Zero mismatches. The integration branch had already moved the same function to commandThreadId.ts, so the merge drops this lane's copy.
- `42029b9c9a`: the claude_background_task_after_root replay fixture entry moved to its folder's fixture.ts, the shape acp_titled_multiselect uses. This one is not byte-identical: the fields and values are unchanged, but the indentation and the now folder-relative transcript URL differ.

An earlier attempt to move the attachment block was reverted before commit: its PDF page counter has three non-null assertions, and a new file would have needed a new budget entry.

## Decisions

| upstream | decision | GOAT commit | reason |
|---|---|---|---|
| `896e64f82d` | adapt (r1) | `f48a38ef22` | A plain ~/.local/bin/claude is no longer native; docs in GOAT wording. apps/server/src/provider/Drivers/ClaudeMaintenance.ts:31 |
| `543ee27fa8` | adapt (r1) | `bddbff2ed9` | The fork omits dir; the test runs the real query runner fork. ClaudeAdapterV2.fork.test.ts |
| `5badea5b45` | adapt (r1) | `94c3cc6886` | Passive "Stop says:" notices hidden. ClaudeStopHookNotice.test.ts |
| `a50ebef78b` | adapt (r1) | `343959bef1` | Steer uuid from GOAT's Crypto; registration after memory admission. ClaudeSteerAcceptance.test.ts |
| `cdbfae86cd` | adapt (r1) | `9048b9bf6e` | claudeProcessExitFailure beside the query runner errors. ClaudeProcessExit.test.ts |
| `458a792087` | adapt (r1) | `6b8042a4b3` | Scheduled wakeup published as a pending background task. ClaudeScheduledWakeup.test.ts |
| `86ae1747ad` | adapt (r1) | `7fb273b2fd` | ClaudeClearSession.test.ts |
| `7315c60b95` | adapt (r1) | `1812d512de` | Latch tokens; GOAT's continuation service gains the generic-failure clearIfCurrent branch |
| `d20d535e32` | adapt (r1) | `22099c4c79` | ClaudeSubagentResume.test.ts |
| `694076dcf3` | adapt (r1) | `fa01058714` | Registration re-checks steersClosed with no yield before the set; covered by `3de5f34f62` |
| `00766e2c02` | adapt (r2) | `6342d95ac2` | The stall watch is ProviderRetryStallWatch.ts; the manager wires it into the event pump (GOAT has no prompt suggestion branch). Claude settles a retry on message_start, Pi on streamed output. Test registered from ProviderRetryStall.testkit.ts |
| `c7618f6c10` | adapt (r2) | `28c4865c8a` | GOAT emits root replies from the text projector snapshot, so the reply is recorded there (non-streaming blocks) and republished interrupted through an option on emitAssistantTextArtifacts; buildAssistantArtifacts takes a status beside GOAT's streaming flag. Web badge captures below |
| `9ce9b1fd41` | adapt (r2) | `e3f49b0c6a` | New ProviderInstallationGate (16 upstream files). GOAT reads it with Effect.serviceOption, as it reads ProviderCliGate, so runtimes without one run ungated; the server, the runtime layer's text generation and the replay harness provide the one gate, and the maintenance runner requires it. Each GOAT TextGeneration method is gated by its model selection's instance. Upstream's gate-providing hunks in ProviderRegistry.test.ts, ProviderInstanceRegistry.test.ts, CodexTextGeneration.test.ts and ClaudeAdapterV2.testkit.ts are not needed |
| `ccc9aaf10b` | adapt (r2) | `35fef98550` | The latch carries the wake's end frame and retired state; claudeWakeNotice.ts gains peekWakeReports and dropWakeReports; tests in ClaudeWakeRetirement.test.ts and ClaudeAutomaticDelivery.integration.test.ts |
| `7462f234e8` | adapt (r2) | `18db0e21d4` | recoverDelegatedTask takes completedRunId or sourceRunId and reports errors. GOAT's replay projection store keeps no delivery state, so its hasPendingDelegatedCompletion never skips a recovery. Tests in DelegatedCompletionDelivery.checkpointRetry.test.ts and ClaudeWakeDispatch.test.ts |
| `d4b77d2448` | not completed in round 2 | | Not a deferral. Next step: add nativeItemId to PendingBackgroundTaskFields with a decode test for an older server payload (no field, banner falls back to taskId) and a blank-id negative case, the adapter's bounded tool-use map, and the ThreadActivityBanners key with before/after captures. packages/contracts/src/orchestrationV2.ts:1038 |
| `d6e5f2e06f` | needs decision | | Options below. Not ported this round |
| `5984bbb36e` | real defer: predecessor | | Needs d6e5f2e06f |
| `86e2cb21c9` | real defer: C4 negative case | | SDK initialization rejection is swallowed upstream without negative coverage |
| `fdd54b942d` | real defer: C4 negative case | | Process-kill safety; the upstream fixture sleeps and kills a PID read from a file |
| `e77384bf00` | real defer: design | | Needs a failure-policy decision on suppressed transcript lookup failures |

Counts: 15 ported over two rounds (10 in round 1, 5 in round 2), all adapt; all 10 effort rows are ported. 1 not completed (d4b77d2448), 1 needs decision (d6e5f2e06f), 4 real defers. 1a5d3737b7 (#3222) keeps one remainder: upstream's timed updates inside a long line; its steer cut-off case is now ported as c7618f6c10.

## d6e5f2e06f: an older server and an unknown persisted effect

The port adds an outbox effect type. An older build claims a row of that type with UPDATE … RETURNING, then rowToEffect fails to decode it (apps/server/src/orchestration-v2/EffectOutbox.ts:303, claim at :817), so the claim fails with EffectOutboxError while the row stays leased; once the lease expires the next claim picks it again. Read from source, not reproduced: whether this starves other effects depends on the claim order and the worker's effect type filter.

- **A. The older build skips and keeps the row.** Claims filter to known effect types, so an unknown row is never claimed. After a downgrade the effort change never applies and nothing else blocks; after re-upgrading, the row runs late, so the newer build must drop it when its turn has ended. Needs a change in the older line too, so it only protects builds released after it.
- **B. Refuse to start, exit 79, like a newer database.** A migration marks the database as needing this build while such rows can exist. A downgrade then stops at startup until the user upgrades or the row is cleared. Safe and loud, but it turns a short-lived effect into a downgrade blocker.
- **C. Avoid a new persisted type.** Apply the effort change through the live turn control path (ProviderTurnControlService), or as an optional field on an existing effect type that an older decoder ignores. After a downgrade the change applies at the next turn instead of the running one. Nothing for an older build to misread; this is the smallest model.

## Fail-first evidence (round 2)

- 00766e2c02: `× ProviderSessionManagerV2 fails a turn whose provider retry never resumes` (Test timed out in 120000ms: nothing stopped the stalled turn); Pi `× marks retry progress recovered when Pi succeeds` (timeout waiting for the recovered row); Claude `× resolves API retries on resumed assistant activity` (timeout).
- c7618f6c10: `× handles aborted_streaming (steered=true, exits=false)`, `expected 'completed' to equal 'interrupted'`.
- 9ce9b1fd41 (wiring stashed): `expected [ 'open query' ] to deeply equal [ 'enter claudeAgent', …(2) ]`, `expected [ 'openSession' ] to deeply equal [ Array(3) ]`, and both maintenance gate tests (`expected [ 'shared installation ran', …(2) ] to deeply equal [ 'other driver ran', …(2) ]`).
- ccc9aaf10b: `the wake after a cancelled queued continuation must offer a new continuation: expected [ { …(6) } ] to have a length of 2 but got 1`. The 13 ClaudeWakeRetirement tests fail before the fix with TypeError (onRunEndedWithoutStarting does not exist yet), so the integration test is the behavioural fail-first.
- 7462f234e8: `expected [] to include 'bdqirlcyw'`, `× checkpoint retry releases a pending sibling after its wake offer failed`, `expected [ { …(16) } ] to have a length of 2 but got 1` (8 tests).

## Surfaces

What users and agents now see, over both rounds: a "Steer waiting" badge on a Claude steer until Claude reads it (web and mobile render the same turn item status); a "Steer delivery not confirmed" notice when Stop leaves a steer unread; the signal named on a turn whose Claude process was killed; passive "Stop says" notices gone; Working with a "Scheduled wakeup" background row while Claude waits on ScheduleWakeup; a self-resumed subagent reopening as running; a delegated Claude child with a scheduled wakeup holding its task in Working up to an hour. Round 2 adds an "interrupted" badge on a reply a steer cut off mid-stream (web; mobile shows the item status it already renders), a turn stuck in a provider retry failing after 15 minutes of silence plus the retry delay, provider updates showing "Waiting for running provider work to finish." while sessions and text generation drain, later Claude wakes delivered after a cancelled continuation, and delegated results kept across wake turns.

Captures: the interrupted badge, browser harness with the app stylesheet (before/after, light and dark): https://raw.githubusercontent.com/goat-si/goat/f579eee4b5d513f9b7c4767ed60635628afc3f6c/3397/c7618-before-light.png, …/c7618-after-light.png, …/c7618-before-dark.png, …/c7618-after-dark.png. The steer badge and notice need Claude frames from a paid session, so they have no capture.

Contracts: no wire schema change this round. ProviderContinuationRequest gains an optional onRunEndedWithoutStarting callback (in-process, not serialized). C4 older-peer cases: none apply to the ported rows; d4b77d2448 and d6e5f2e06f carry them.

## Known limits

- goat#3412: a late steer `pending` can overwrite `completed` (shared with upstream).
- Until this round merges into chase/t3-261114-all, a cancelled queued Claude continuation still drops later wakes (ccc9aaf10b), delegated results can be lost across wake turns (7462f234e8) and a steer that cuts off a streaming reply leaves it as completed (c7618f6c10).
- d4b77d2448 is not ported: background commands do not show their running time.

## Gate (round 2, head 9ed11e8829, after merging origin/chase/t3-261114-all at 24c7a4e0da)

check:changed was not run here: the 1-minute load on pen-mac-studio was 42 to 50 at hand-over (limit 18), so the coordinator gates elsewhere. On the merged tree: `tsc --noEmit` for apps/server has 0 errors (the AntigravityDriver.ts:480 break is gone on the tip); `node scripts/goat-rename.ts --check`: 0 lines with T3 residue; vp fmt and vp lint passed on every commit's files (pre-commit). The knip `gt` finding: `gt` is still a devDependency at apps/web/package.json:123 on the tip and is used only as the CLI of the i18n:generate and i18n:translate scripts; knip itself was not run.

Focused runs before the merge (VITEST_MAX_WORKERS 2 to 4): ProviderSessionManager test, lifecycle and sessionRun 111 passed; provider-pi adapter and rpc.framing 132 passed; the Claude adapter directory with ProviderContinuationService and ClaudeAutomaticDelivery 34 files, 476 passed; installation gate, maintenance runner and output, text generation and the Claude gate test 16 files, 333 passed; DelegatedCompletion*, ClaudeAdapterV2, ClaudeWakeDispatch, ProviderTurnControlService, RunFinalizationQueue, ThreadStop and testkit 34 files, 667 passed; testkit replay fixtures 21 files, 236 passed; ClaudeSteerAcceptance 6 passed; ClaudeWakeRetirement 13 passed; c7618 capture harness 2 passed (not committed).

Budget entries touched (read from oxlint-plugin-goat/code-budgets.json on the merged tree; none raised): ClaudeAdapterV2.ts 10941/11224, ClaudeAdapterV2.test.ts 16510/16924, ProviderSessionManager.ts 3021/3128, ProviderSessionManager.test.ts 6149/6326, Orchestrator.ts 13876/13908, ProjectionStore.ts 8148/8836, EffectWorker.ts 985/1005, DelegatedCompletionDelivery.test.ts 2200/2332, testkit/fixtures/index.ts 1829/1844, server.ts 1327/1339, providerMaintenanceRunner.test.ts 1004/1246, provider-pi adapter.ts 3469/3476, provider-pi adapter.test.ts 4712/4784, ClaudeAdapterV2.testkit.ts 2829/2829 (unchanged).

NOT RUN: check:changed and its test step (load); knip; the merged tree's tests (only typecheck and the rename check ran after the merge); a real-client pass of the interrupted badge, the steer badge and the notice; ClaudeAdapterV2.test.ts as a whole file on its own after the merge; CI (runs once on #3397); an independent review of round 2.

Model: claude-opus-5-5 (anthropic) through the Codex harness in GOAT.

