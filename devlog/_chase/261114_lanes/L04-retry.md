# L04 retry (orchestrator), cycle 261114

Lane branch: chase/t3-261114-orchestrator-retry. Hand-over head: d821f3d57b75406539917f5f752ffb6abbabf934 (first review). Draft PR #3396 was closed under the 2026-11-15 single-PR rule; this file is the record.

This retry of L04 decides 22 upstream commits (the 21 effort deferrals of #3210 plus `eeb31c11b7`, whose only blocker was one of them) and ports 19; each port names its upstream commit and decision in its message. It also closes the #3210 review items P3-1 and P3-4 and gives the reason the Missing tools example stays out.

Reconciling the count: the cycle card asks for 22 effort deferrals without a row list. The worklist has 21 effort rows; the 22nd is `eeb31c11b7`, recorded as a predecessor deferral whose only predecessor (`7f65c9c393`) was itself an effort deferral.

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

Moves to make room for the ports. Each is a byte-identical move in its own commit; no budget was raised or lowered: ThreadManagementService.ts errors (`75e010d586`, 2201 to 2043 lines), EffectOutbox.ts request schema (`4f0c87d407`, 1000 to 894), PR sync test fixtures, the PR rate limit wrapper, provider event routing (RunExecutionService.ts), run controls and start types (ProviderTurnStartService.ts), EventSink errors, the SelectionRestart fixture, command thread lookup (Orchestrator.ts), two test helpers, and the OpenCode fixture prompts (fixtures/shared.ts).

## Decisions

Of 22 rows: 19 ported (18 adapt, 1 take), 0 skipped, 0 deferred, 0 Needs decision, and 3 not attempted (`d70bfe6e97`, `daed1dd327`, `78b654f998`). Not attempted is not a deferral; those three go to the next round.

C4: none. No port adds or changes a wire contract, persisted data, auth or permissions. `91f55d90e9` adds `batchesReads` to the server-side `PullRequestProvider` interface (packages/source-control-core), which never crosses the wire. The P3-4 sentence is description text only.

Deferrals are tracked in #3176.

| upstream | decision | GOAT commit | reason |
|---|---|---|---|
| `7f65c9c393` | adapt | `7395802b34` | Hosts' not-found answers back off to the slow cadence; the set is pruned each sweep. apps/server/src/orchestration-v2/PullRequestSyncReactor.ts:360 |
| `eeb31c11b7` | adapt | `f1e6de8ae4` | Settling refreshes unsynced links once, skipping known-missing ones. apps/server/src/orchestration-v2/PullRequestSyncReactor.ts:718 |
| `91f55d90e9` | adapt | `f3da0b3476` | Batched reads share requests, with host fan-out bounded at 16 and pools of 100 and 25. Provider resolution failures are logged, never hidden. apps/server/src/orchestration-v2/PullRequestSyncReactor.ts:616 |
| `7d8f6c9481` | adapt | `04d4acf491` | Resume fallback records a handoff ordered before the prompt; the replay harness gains the position store. apps/server/src/orchestration-v2/ProviderTurnStartService.ts:1015 |
| `52c1491c8a` | adapt | `55cc418225` | A handoff completes the root run and settles native children; Stop in the same transaction is kept. apps/server/src/orchestration-v2/RunExecutionService.ts:1050 |
| `2de337003d` | adapt | `88d9b8aea7` | A turn that starts after Stop settled is interrupted; unreadable ownership interrupts and fails visibly. apps/server/src/orchestration-v2/RunExecutionService.ts:973 |
| `c3e5bfc027` | adapt | `74bbaf4066` | GOAT's native fork path hits this; a failed native fork falls back to bounded source history. apps/server/src/orchestration-v2/goat/NativeForkRecovery.ts:23 |
| `37e0fd378a` | adapt | `78985f474e` | Unreadable recovery state fails the run once retries are exhausted; the existing checkout test keeps its expectations and passes `willRetry` as upstream's does. apps/server/src/orchestration-v2/ProviderTurnStartService.ts:587 |
| `3ffd240fc7` | adapt | `845c365a96` | Run finalization refreshes a missing repository identity. apps/server/src/orchestration-v2/RunFinalizationService.ts:103 |
| `c833a60de2` | adapt | `0438c7c7d5` | Branch rename failure records a run notice; both launch harnesses provide EventSink. apps/server/src/orchestration-v2/ThreadLaunchService.ts:309 |
| `15d1ef5e09` | adapt | `4e889ef547` | Stop waits on a bounded committed-event stream for the turn and attempt to settle; stream failures stay visible. apps/server/src/orchestration-v2/ProviderTurnControlService.ts:301 |
| `805251b670` | adapt | `21d235e1aa` | Settings changes probe sessions before detaching, keeping background work alive. apps/server/src/orchestration-v2/Orchestrator.ts:3152 |
| `bd7d264401` | adapt | `92ac0f33ca` | Conversation selection skips scheduled fresh runs, including after compaction. apps/server/src/orchestration-v2/ProviderContextBoundaries.ts:174 |
| `c2931a6e9c` | adapt | `77b42f5359` | Fallback names keep the project prefix; an unreadable settings store fails preparation visibly. apps/server/src/orchestration-v2/ThreadLaunchService.ts:466 |
| `52ba328982` | adapt | `8d296a4a9c` | The incremental scan is stored on GOAT's bounded tracks; the first-receipt and turn modes are unchanged. apps/server/src/orchestration-v2/assistantStreaming.ts:45 |
| `6be26850fc` | adapt | `937257f6b3` | Portable fork coverage names the source thread. The side chat divider hunk has nothing to apply to, because GOAT side chats are not forks (`50c1c5dc53` was skipped earlier). apps/server/src/orchestration-v2/ContextHandoffService.ts:459 |
| `c085a0aa5d` | take | `0f34bd1b44` | The baseline snapshot is bounded to 5 s while still waiting on the lock. apps/server/src/orchestration-v2/CheckpointService.ts:34 |
| `48a56faaa2` | adapt | `ed7730363a` | Upstream's scenario step and fixture flag, applied by hand. apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts:46 |
| `10fbff5ab6` | adapt | `d5635e64ce` | The queued cancel reads only its run's user message. GOAT has no deferred-steer reactor. apps/server/src/orchestration-v2/Orchestrator.ts:9288 |
| `d70bfe6e97` | not attempted | - | Not reached before the READY gate; the restore path is at apps/server/src/orchestration-v2/goat/prepareTurnWorkspace.ts:27. |
| `daed1dd327` | not attempted | - | Not reached before the READY gate. apps/server/src/orchestration-v2/RestartBackgroundNote.ts:190 |
| `78b654f998` | not attempted | - | Not reached before the READY gate. apps/server/src/orchestration-v2/Orchestrator.ts:9883 |

## Known limits

- Three effort rows remain (see the table); they go to the next round.
- `15d1ef5e09` carries upstream's ProjectionControlReads and BackgroundWorkStop test edits. It does not carry its ProviderTurnControlService.test.ts and SteeringCompletion.integration.test.ts edits, whose scenarios differ in GOAT.
- The `8d236998d0` queue-wake follow-up from #3210 is unchanged and still tracked in #3176.

## Surfaces

- **Server:** all changes.
- **Web, desktop, mobile:** no client code changes. New run notices (branch rename failure, unreadable recovery state) and the resume handoff render through existing turn item types.
- **Agents/MCP:** `goat_thread_send` gains one description sentence; the injected instructions are unchanged.
- **Providers:** server-side changes in Claude background work (`805251b670`), native forks (`c3e5bfc027`) and the GitHub PR provider's `batchesReads` (`91f55d90e9`). No adapter protocol changes.

## Captures

None: there is no UI change. New notices use existing turn item rendering.

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

Model: anthropic/claude-opus-5-5 via Codex in GOAT on pen-mac-studio, coordinated by anthropic/claude-opus-5-5
