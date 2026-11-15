# L04 retry (orchestrator), cycle 261114

Lane branch: chase/t3-261114-orchestrator-retry. Hand-over head: d821f3d57b75406539917f5f752ffb6abbabf934 (final review: APPROVE WITH NITS). Head after the review fixes: 41992d56ef17f9e74792be9b8777c9bd047a2ea3 (see Final review delta). Draft PR #3396 was closed under the 2026-11-15 single-PR rule; this file is the record.

This retry of L04 decides 22 upstream commits (the 21 effort deferrals of #3210 plus `eeb31c11b7`, whose only blocker was one of them) and ports 19; each port names its upstream commit and decision in its message. It also closes the #3210 review items P3-1 and P3-4 and gives the reason the Missing tools example stays out.

Reconciling the count: the cycle card asks for 22 effort deferrals without a row list. The worklist has 21 effort rows; the 22nd is `eeb31c11b7`, recorded as a predecessor deferral whose only predecessor (`7f65c9c393`) was itself an effort deferral. One of the 21, `c3e5bfc027`, was not an effort deferral when the lane ported it: the coordinator had decided SKIP on 2026-11-15 (card row #384), and the lane ported it anyway without saying so. Coordinator decision 2026-11-15 changed from skip to adapt (GOAT design) after the final review; the row below gives the reason and the conditions.

## Ported (upstream titles)

- fix(server): PR sync stops reading missing pull requests every minute (#17800)
- fix(server): settling a thread refreshes its pull request status once (#33095)
- fix(server): PR sync reads share GitHub requests again on busy servers (#28422)
- fix(server): show a context handoff when a provider conversation can't be resumed (#28195)
- fix(server): successful worktree handoffs complete normally (#24545)
- fix(server): Stop interrupts a provider turn that starts while it lands (#34912)
- fix(server): forks whose source session is gone start fresh instead of failing every send (#27729)
- fix(server): a run whose recovery state can't be read fails instead of staying starting (#35013)
- fix(server): a turn that adds a Git remote shows "Add to another machine" right away (#29947)
- fix(server): tell the thread when its worktree branch keeps the temporary name (#34813)
- fix(server): Stop waits for the turn to settle instead of polling (#35948)
- fix(server): thread setting changes no longer end a Claude session's background work (#35029)
- fix(server): a fresh-session scheduled run no longer takes over the thread's conversation (#36103)
- fix(server): honor worktree prefixes when automatic naming fails (#35718)
- fix(server): avoid reparsing streamed replies from the beginning (#24432)
- fix(server): side chat fork context recovers history from the parent thread (#34845)
- fix(server): a slow baseline checkpoint no longer holds every prompt for 30 seconds (#34849)
- test(server): idle-resume replays wait for the session release before the next prompt (#35720)
- fix(server): deferred-steer check and queued cancel no longer read a thread's whole history (#36100)

#3210 review items:

- **P3-1:** a replayed restart already reported its recorded delivery after the provider is disabled, because `assertProviderInstanceEnabled` skips commands that have a receipt (apps/server/src/orchestration-v2/ThreadManagementService.ts:689). `5ac0f89110` locks this in with a test. Removing the receipt skip makes it fail with `ThreadManagementProviderInstanceDisabledError`.
- **P3-4:** the `goat_thread_send` description gains one sentence. A provider that can stop but not restart stops the turn and queues the message first. Restart is refused when the provider cannot stop the turn, Stop already reached it, or either message is /compact or /logout (`a2f111ef0d`, packages/contracts/src/agentSurface/entries/thread.ts:242).
- **Missing tools line:** the `mcp__goat__` example is not restored. ACP's always-injected instructions sit exactly at their 6,144 B budget, and the 25-byte example makes them 6,169 B, which `node scripts/agent-surface/context-budget.ts --check` rejects. Restoring it would mean cutting another line of guidance (packages/provider-core/src/server/orchestrationInstructions.ts:33).

Moves to make room for the ports, each in its own commit; no budget was raised or lowered. Most are byte-identical. Two are equivalent moves, not byte-identical: `3b6caf073c` reindents the run controls into goat/ProviderRunControls.ts, and `5b7bc0a67d` reshapes the memory refresh factory as it moves into goat/MemoryRefreshFactory.ts. The moves: ThreadManagementService.ts errors (`75e010d586`, 2201 to 2043 lines), EffectOutbox.ts request schema (`4f0c87d407`, 1000 to 885), PR sync test fixtures, the PR rate limit wrapper, provider event routing (RunExecutionService.ts), run controls and start types (ProviderTurnStartService.ts), EventSink errors, the SelectionRestart fixture, command thread lookup (Orchestrator.ts, now commandThreadId.ts, the same file as the projection and adapters-retry lanes), two test helpers, and the OpenCode fixture prompts (fixtures/shared.ts).

## Decisions

Of 22 rows: 19 ported (16 adapt, 3 take), 0 skipped, 0 deferred, 0 Needs decision, and 3 not attempted (`d70bfe6e97`, `daed1dd327`, `78b654f998`). Not attempted is not a deferral; those three go to the next round.

C4: none. No port adds or changes a wire contract, persisted data, auth or permissions. `91f55d90e9` adds `batchesReads` to the server-side `PullRequestProvider` interface (packages/source-control-core), which never crosses the wire. The P3-4 sentence is description text only.

Deferrals are tracked in #3176.

| upstream | decision | GOAT commit | reason |
|---|---|---|---|
| `7f65c9c393` | adapt | `7395802b34` | Hosts' not-found answers back off to the slow cadence; the set is pruned each sweep. apps/server/src/orchestration-v2/PullRequestSyncReactor.ts:360 |
| `eeb31c11b7` | take | `f1e6de8ae4` | Identical to upstream after the rename. Settling reads the thread's open and closed links once and skips none of them. apps/server/src/orchestration-v2/PullRequestSyncReactor.ts:700, :804 |
| `91f55d90e9` | adapt | `f3da0b3476` | Batched reads share requests, with host fan-out bounded at 16 and pools of 100 and 25. Provider resolution failures are logged, never hidden. apps/server/src/orchestration-v2/PullRequestSyncReactor.ts:616 |
| `7d8f6c9481` | adapt | `04d4acf491` | Resume fallback records a handoff ordered before the prompt; the replay harness gains the position store. apps/server/src/orchestration-v2/ProviderTurnStartService.ts:1015 |
| `52c1491c8a` | adapt | `55cc418225` | A handoff completes the root run and settles native children; Stop in the same transaction is kept. apps/server/src/orchestration-v2/RunExecutionService.ts:1022 |
| `2de337003d` | adapt | `88d9b8aea7` | A turn that starts after Stop settled is interrupted; unreadable ownership interrupts and fails visibly. apps/server/src/orchestration-v2/RunExecutionService.ts:973 |
| `c3e5bfc027` | adapt (GOAT design) | `74bbaf4066`, `4a1482086d` | Coordinator decision 2026-11-15 changed from skip to adapt (GOAT design) after the final review. The skip assumed GOAT had no native fork fallback because upstream's (`50c1c5dc53`) was skipped; the lane built one in a GOAT module instead: after the last retry fails it starts a fresh native session with the source's history, written only while the run attempt is current, with the provider error redacted in the notice. Conditions, met in `4a1482086d` with tests first: the handoff names the source thread for omitted history (:84), and it includes what the source inherited from its own fork parents, as upstream's readForkHistoryItems does (:43). goat#3348 stays open for the real-provider reproduction (NOT RUN). apps/server/src/orchestration-v2/goat/NativeForkRecovery.ts:64 |
| `37e0fd378a` | adapt | `78985f474e` | Unreadable recovery state fails the run once retries are exhausted; the existing checkout test keeps its expectations and passes `willRetry` as upstream's does. apps/server/src/orchestration-v2/ProviderTurnStartService.ts:587 |
| `3ffd240fc7` | adapt | `845c365a96` | Run finalization refreshes a missing repository identity. apps/server/src/orchestration-v2/RunFinalizationService.ts:103 |
| `c833a60de2` | adapt | `0438c7c7d5` | Branch rename failure records a run notice; both launch harnesses provide EventSink. apps/server/src/orchestration-v2/ThreadLaunchService.ts:309 |
| `15d1ef5e09` | adapt | `4e889ef547`, `208994ec6a` | Stop waits on the internal committed-event stream for the turn and attempt to settle, as upstream; the 2 s timeout bounds the subscription, and stream failures stay visible. apps/server/src/orchestration-v2/ProviderTurnControlService.ts:301 |
| `805251b670` | adapt | `21d235e1aa`, `00ad33917b` | Settings changes probe sessions before detaching, keeping background work alive; upstream's comment on serialized commands moves with the code. apps/server/src/orchestration-v2/Orchestrator.ts:3176 |
| `bd7d264401` | adapt | `92ac0f33ca` | Conversation selection skips scheduled fresh runs, including after compaction. apps/server/src/orchestration-v2/ProviderContextBoundaries.ts:174 |
| `c2931a6e9c` | adapt | `77b42f5359` | Fallback names keep the project prefix; an unreadable settings store fails preparation visibly. apps/server/src/orchestration-v2/ThreadLaunchService.ts:466 |
| `52ba328982` | adapt | `8d296a4a9c` | The incremental scan is stored on GOAT's bounded tracks; the first-receipt and turn modes are unchanged. apps/server/src/orchestration-v2/assistantStreaming.ts:45 |
| `6be26850fc` | adapt | `937257f6b3` | Portable fork coverage names the source thread. The side chat divider hunk has nothing to apply to, because GOAT side chats are not forks (`50c1c5dc53` was skipped earlier). apps/server/src/orchestration-v2/ContextHandoffService.ts:459 |
| `c085a0aa5d` | take | `0f34bd1b44` | The baseline snapshot is bounded to 5 s while still waiting on the lock. apps/server/src/orchestration-v2/CheckpointService.ts:34 |
| `48a56faaa2` | take | `ed7730363a` | Identical to upstream after the rename: its scenario step and fixture flag. apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts:46 |
| `10fbff5ab6` | adapt | `d5635e64ce` | The queued cancel reads only its run's user message. GOAT has no deferred-steer reactor. apps/server/src/orchestration-v2/Orchestrator.ts:9288 |
| `d70bfe6e97` | not attempted | - | Not reached before the READY gate; the restore path is at apps/server/src/orchestration-v2/goat/prepareTurnWorkspace.ts:27. |
| `daed1dd327` | not attempted | - | Not reached before the READY gate. apps/server/src/orchestration-v2/RestartBackgroundNote.ts:190 |
| `78b654f998` | not attempted | - | Not reached before the READY gate. apps/server/src/orchestration-v2/Orchestrator.ts:9883 |

## Known limits

- Three effort rows remain (see the table); they go to the next round.
- `15d1ef5e09` carries upstream's ProjectionControlReads and BackgroundWorkStop test edits. It does not carry its ProviderTurnControlService.test.ts and SteeringCompletion.integration.test.ts edits, whose scenarios differ in GOAT.
- The `8d236998d0` queue-wake follow-up from #3210 is unchanged and still tracked in #3176.
- Upstream has this too: when a turn starts after Stop landed, #34912's forked interrupt is only logged if it fails (apps/server/src/orchestration-v2/RunExecutionService.ts:1440). A provider that never confirms keeps that turn running under an interrupted run, with no Force stop offered.
- `c3e5bfc027`: the failure was not reproduced with a real provider; goat#3348 stays open for that. The recovered history keeps rolled-back runs, as GOAT's portable fork path in Orchestrator.ts does; that path also leaves out the source's inherited history, which upstream includes.
- `af9b4e41de` waited for `52c1491c8a`, which is now ported; only its C4 question about `detachedThreadId` remains (#3176).

## Surfaces

- **Server:** all changes.
- **Web, desktop, mobile:** no client code changes, but users see new text. #35029 adds a refusal when a thread setting change would end background work ("The current session is still running background agents or commands, and this change would end them...", apps/server/src/orchestration-v2/Orchestrator.ts:3181), shown on web, desktop and mobile as a failed command. New notices: "Native fork failed" (goat/NativeForkRecovery.ts:130), "Branch not renamed" (ThreadLaunchService.ts:333), "Couldn't read thread state" (ProviderTurnStartService.ts:588) and "Recovered context" (ProviderTurnStartService.ts:1034). They render through existing rows: system notices and errors in web MessagesTimeline.logic.ts and mobile threadActivity.ts, the handoff in mobile thread-handoff-row.tsx.
- **Agents/MCP:** `goat_thread_send` gains one description sentence; the injected instructions are unchanged. Agents changing a thread setting get the same #35029 refusal as the command error.
- **Providers:** server-side changes in Claude background work (`805251b670`), native forks (`c3e5bfc027`) and the GitHub PR provider's `batchesReads` (`91f55d90e9`). No adapter protocol changes.

## Captures

None. The new text listed under Surfaces renders through existing rows (a system notice, an error, a handoff row, a command error), so no layout or component changed; a capture would show existing rows with new words.

## Merges

- `41b3ab1bc6` merges origin/chase/t3-261114-all `56421003ff` into the lane branch with no conflicts. The combined tree put apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts at 2965 lines against its 2963 budget (this lane added 13 lines in `7d8f6c9481`), so `d821f3d57b` moves `waitForIdle` byte-identically into testkit/providerSwitchWaitForIdle.ts (now 2936 lines; its 42 tests pass). This lane changes no budget entry, so there is no merged-length table.
- `cada56aa7e` merges origin/dev `fe4bb6379a`. It resolves RunExecutionService.ts by keeping the routing extraction and carrying dev's new `steer.updated` route into ProviderEventRouting.ts. It resolves the ProviderEventIngestor.ts imports by taking dev's `modelSelectionsEqual`-only import and dropping the now-unused `isTemporaryWorktreeBranch`. The only `vi.mock` factory of a split module (ShellSnapshotLoads.test.ts, ThreadManagementService.ts) is empty and unaffected.
- Budget entries: none changed, so there is no merged-length table.

## Tests

Fail-first evidence, before each fix:

- `7f65c9c393`: missing PR reads were 30 against an expected 2.
- `eeb31c11b7`: the refresh observed `[]` instead of `[5, 6]`.
- `91f55d90e9`: 25 concurrent reads instead of 30.
- `7d8f6c9481`: `[user_message, assistant_message]` instead of `[handoff, user_message]`.
- `52c1491c8a`: the run was `interrupted` instead of `waiting`.
- `2de337003d`: the interrupt assertion was false.
- `c3e5bfc027`: got `["Provider turn failed to start"]`.
- `37e0fd378a`: the run stayed `starting` instead of `failed`.
- `3ffd240fc7`: expected 0 to equal 1.
- `c833a60de2`: the notice run id was null.
- `15d1ef5e09`: "Stop subscribes to committed settlement events: expected +0 to be above +0".
- `805251b670`: `closedSessions` was non-empty.
- `bd7d264401`: native thread `:1` instead of `:0`.
- `c2931a6e9c`: branch `goat/<hash>` instead of the configured prefix.
- `52ba328982`: "expected 81800 to be less than 1600".
- `6be26850fc`: the coverage did not include `threadId:"fork-boundary-source"` (2 cases).
- `c085a0aa5d`: the slow baseline never finished; the test hit vitest's 120 s ceiling.
- `10fbff5ab6`: the cancel's user-message read was not bounded to the run.
- `48a56faaa2` is test-only and has no fail-first step.

Focused runs after the fixes, all passing: the touched orchestration and PR suites (20 files, 631 tests), the streaming and adapter suites (82 files, 1,229), the replay fixture suites (4 files, 77), the queued-cancel suites (9 files, 290), CheckpointService (6), and ThreadFork plus ContextHandoff (15).

Gate on the dev-merged head `cada56aa7e` (before hand-over) (GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 VITEST_MAX_WORKERS=4 vp run check:changed):

```
check:changed summary
  pass  format  0.2s
  pass  lint  0.9s
  pass  knip 1/2  13.4s
  pass  knip 2/2  18.6s
  pass  graphql (apps/server)  1.4s
  pass  graphql (packages/source-control-github)  1.5s
  pass  agent surface audit  9.4s
  pass  agent context budget  8.8s
  pass  typecheck (38 packages)  16.6s
  pass  test (604 files)  753.3s
  A full CI run (ci:full) also runs: full test suites, build, release smoke
  unused patch check skipped: no dependency files changed
  pass not cached: files changed during the run

Test Files  602 passed | 2 skipped (604)
Tests  8783 passed | 5 skipped (8788)
EXIT 0
```

`node scripts/goat-rename.ts --check`: 0 lines with T3 residue in 0 files, 0 dropped paths

Hand-over gate on `d821f3d57b` (the all-branch merge), run with pipefail:

```
check:changed summary
  pass  unused patches  0.8s
  pass  format  0.3s
  pass  lint  5.6s
  pass  knip 1/2  11.3s
  pass  knip 2/2  16.5s
  pass  graphql (apps/server)  1.5s
  pass  graphql (packages/source-control-github)  1.8s
  pass  agent surface audit  7.7s
  pass  agent context budget  7.5s
  pass  typecheck (42 packages)  14.7s
  FAIL  test (1596 files)  2123.3s
Test Files  1 failed | 1587 passed | 8 skipped (1596)
Tests  1 failed | 24571 passed | 24 skipped (24596)
EXIT 1
```

The gate failed on one test, and that failure comes from this machine. packages/ssh/src/runtimeFactsScripts.test.ts:459, "reads a built runner in one call and parses only the lines before its end line", fails with `expected +0 to equal 1`. It traces through `BASH_XTRACEFD`, which arrived in bash 4.1, and this host's /bin/bash is 3.2.57, so the trace stays empty. The test and runtimeFactsScripts.ts are identical on origin/dev, origin/chase/t3-261114-all and this lane, and the lane changes nothing under packages/ssh. It reproduces when run alone. The earlier gate on the dev merge (`cada56aa7e`) passed with EXIT 0 because packages/ssh was not in its changed set.

`node scripts/goat-rename.ts --check` on `d821f3d57b`: 0 lines with T3 residue in 0 files, 0 dropped paths.

NOT RUN: lane review (Codex pool at its weekly limit); CI (runs once on #3397); a real-client pass, since there is no visible UI change.

## Final review delta

Head `41992d56ef17f9e74792be9b8777c9bd047a2ea3` closes the final review (APPROVE WITH NITS on `d821f3d57b`). Commits on top of the reviewed head:

- `4a1482086d` fix(server): native fork recovery reads history from the source and its fork ancestors (P2-1 conditions a and b)
- `3838314d84` refactor(server): name the command thread module commandThreadId.ts like the other lanes (P2-2; blob c150d91d8b, as in the projection and adapters-retry lanes)
- `208994ec6a` fix(server): Stop waits on the internal event stream, as upstream (P3-1)
- `00ad33917b` fix(server): restore the comment upstream moves with the background work guard (P3-6)
- `2b4caa5ae7` merges origin/chase/t3-261114-all `554708b1bc` with no conflicts
- `41992d56ef` merges origin/chase/t3-261114-all `74ae8cc7b2` (L03 projection)

Fail-first, before each fix:

- `4a1482086d` (b): the recovered history lacked the parent's marker, `expected -1 to be at least +0`.
- `4a1482086d` (a): with (b) fixed, the coverage pointed at the fork, `expected 'Provider context handoff. Thread: fork-missing-target…' to include 'threadId:"fork-missing-source"'`.
- L03 run controls: with the lane's earlier goat/ProviderRunControls.ts, L03's status check test reads the recovery projection 6 times, `expected 6 to be 1`.
- `208994ec6a` has no fail-first test. Only live events that outrun the consumer can hit the bounded stream's 1,000 event limit, which depends on fiber scheduling; a test for it would need timing. The existing Stop suites pass.

Conflicts in the L03 merge and their resolutions:

| File | Resolution |
|---|---|
| EventSink.ts | L03's EventSinkShape.ts is the one home for the errors and the shape; it now carries `writeIfRunCurrent`'s `unlessInterruptRequested`. This lane's EventSinkErrors.ts (identical error classes) is deleted. |
| ProviderTurnStartService.ts | Keeps the call to goat/ProviderRunControls.ts, which now uses L03's `getRun` reads for `isCurrentAttemptInStatus` and `shouldFinalizeRun` and keeps `hasWorkspaceMoved`. |
| ProviderTurnStartService.localCommand.testkit.ts | L03's shared `getRuntimeRecoveryProjection` mock and `getRun`; the mock fails when `recoveryReadFailure` is set. |
| ThreadManagementService.ts (no textual conflict) | Drops the now unused `MessageId` import: the tip moved the send input types to threadManagementTypes.ts and this lane moved the errors out. |
| commandThreadId.ts | Same blob on both sides. |

L19 was not in the tip, so the ThreadManagementErrors.ts consolidation is not applied.

Budgets on `41992d56ef` (`node oxlint-plugin-goat/update-code-budgets.ts` exit 0, baseline left unchanged; no entry raised):

| File | Lines | Budget |
|---|---|---|
| Orchestrator.ts | 13873 | 13908 |
| EventSink.ts | 1010 | 1154 |
| ProviderTurnStartService.ts | 1581 | 1587 |
| ThreadManagementService.ts | 1997 | 2201 |
| RunExecutionService.ts | 2053 | 2172 |
| ProviderTurnStartService.test.ts | 1257 | 1257 |
| RunExecutionService.test.ts | 3962 | 3962 |
| runtimeLayer.test.ts | 10007 | 10007 |
| ThreadFork.execution.test.ts | 976 | unlisted (1000) |
| goat/NativeForkRecovery.ts | 189 | unlisted (1000) |
| EffectOutbox.ts | 885 | unlisted (1000) |

Focused runs on `41992d56ef`, all passing: ThreadFork, the ProviderTurnStartService suites, ProviderTurnControlService, BackgroundWorkStop, ProjectionControlReads, EventSink and ContextHandoff (9 files, 108 tests); every user of the local command testkit (14 files, 113 tests); ThreadManagementService and RunExecutionService (142 tests). Server typecheck exit 0.

Gate on `41992d56ef`, run by the coordinator on pen-macbookair (cpaui-MacBookAir.local, thread mcp:ede68b25) because pen-mac-studio's load stayed far above 18 (GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 VITEST_MAX_WORKERS=4 vp run check:changed): format, lint, knip 1/2 and 2/2, graphql x2, the audits and typecheck (42 packages) pass. Tests: 1791 files (1779 passed, 4 failed, 8 skipped), 26487 tests (26415 passed, 48 failed, 24 skipped), exit 1. Verdict after triage: PASS.

| Failing file | Failures | Triage |
|---|---|---|
| packages/ssh SshWorkspaceSync.test.ts | 44 of 84 | Full-suite load (remote_init against push, one 120 s timeout). Passes alone, 84/84, twice. |
| packages/ssh runtimeFactsScripts.test.ts | 1 | goat#3363: bash 3.2 on that host; same on the base tip. |
| tunnel.client-session test | 1 | goat#3363: no node on PATH in a non-interactive shell; same on the base tip. |
| FcmDeliveries PostgreSQL outage tests | 2 | No PostgreSQL installed on that Mac; same on the base tip. |

`node scripts/goat-rename.ts --check`: 0 lines with T3 residue in 0 files, 0 dropped paths.

The integration tip moved to `bd69c4db0b` after the gate; the coordinator reports `41992d56ef` merges into it cleanly by merge-tree and owns that merge.

NOT RUN: a real-provider reproduction for goat#3348; a real-client pass (no client code changed); a deterministic overflow test for `208994ec6a` (see above).

Model: anthropic/claude-opus-5-5 via Codex in GOAT on pen-mac-studio, coordinated by anthropic/claude-opus-5-5
