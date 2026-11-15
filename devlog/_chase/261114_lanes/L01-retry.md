# L01 retry (Claude), cycle 261114

Lane branch: chase/t3-261114-claude-retry. Hand-over head: 637128e1736f1cd2e274992a10e6f33cb6e6e9a9 (first review). The original L01 PR #3222 is merged; this file is the full record for the retry (no PR body).

This round ports 11 upstream commits (the 896e64f82d coordinator item, 8 of the 10 effort deferrals, and a50ebef78b and 694076dcf3, whose predecessors are now in origin/chase/t3-261114-all) and closes the five review items. Five rows are unfinished and go to the next round: three effort rows and two predecessor rows whose predecessors this round ported. Each port commit ends with one paragraph holding `Upstream:` and `Decision:`.

## Review items

- **#3222 P3-1:** the Windows skip in ProviderInstanceRegistry.test.ts is a platform gate, so it now has a plain comment ("Windows cannot execute the mock CLI script.") instead of "quarantine: #3176" (`db42d7fb88`).
- **#3222 P3-5:** ClaudeSyncedSkills.test.ts temp directories use the `goat-claude-skills-` prefix (`db42d7fb88`).
- **#3193 P3-1:** ProviderInstanceRegistry.claudeGrant.test.ts is deleted; ProviderInstanceRegistry.test.ts already covers the selected-grant redemption and unknown-grant rejection (`db42d7fb88`).
- **#3193 P3-6:** ClaudeAdapterV2.ts gets back the two-line wake deadline comment and the 403 authentication_failed comment. PromptRefusal.ts now also says that a query that exits before the turn attaches never offered the prompt, so the native session stays usable. The inline handoff skill-mention regression moves from ClaudeStopTeardown.test.ts into ClaudeGoalCommand.test.ts (`1f2efc7152`). The Claude adapter test layer, copied in two files, is now ClaudeAdapterTestLayer.testkit.ts.

## Moves for room (byte-identical, own commits, no budget raised)

- `c20d5429af`: the Claude Agent SDK query runner (service, errors, protocol logging, worker fork, 903 lines) moves from ClaudeAdapterV2.ts to ClaudeAgentSdkQueryRunner.ts. A script check found zero line mismatches. Only `export` keywords and the service key (which follows the new module path) changed. Names other modules use are re-exported from the adapter.
- `247e4ad9c5`: the native fork test moves to ClaudeAdapterV2.fork.test.ts.
- `a1c81ccb62`, `a41b2b3a5d`: wake frame builders, wake constants, subagent frame builders and `subagentRouting` move from the background wake describe to ClaudeWakeFrames.testkit.ts. Only indentation and `export` changed.
- `f84036007a`: the budgets for ClaudeAdapterV2.ts (11801 to 11224), ClaudeAdapterV2.test.ts (17382 to 16924) and ClaudeAdapterV2.testkit.ts (2833 to 2829) drop to their real lengths. These are this lane's own entries only, read with update-code-budgets.ts.

Focused test files that drive the wake harness with `offerAndWait` or `awaitUntil` need the same `effect/Queue` capture mock as ClaudeAdapterV2.test.ts. Without it, `awaitEventsRecorded` never resolves. Each new file carries the mock.

## Decisions

| upstream | decision | GOAT commit | reason |
|---|---|---|---|
| `896e64f82d` | adapt | `f48a38ef22` | A plain ~/.local/bin/claude no longer counts as native; `/claude/versions/` does; `requiresCommandPath: true`. The docs hunk is in GOAT wording in docs/user/install.md and docs/internals/providers.md; upstream's mise line is dropped (ade473018d deferred). apps/server/src/provider/Drivers/ClaudeMaintenance.ts:31 |
| `543ee27fa8` | adapt | `bddbff2ed9` | The fork omits `dir`, so the SDK finds the transcript by session id; the test runs the real query runner fork without upstream's PortScanner layer, which GOAT's runner does not need. apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts (forkOptions) |
| `5badea5b45` | adapt | `94c3cc6886` | Passive "Stop says:" notices are hidden; the test is in ClaudeStopHookNotice.test.ts |
| `a50ebef78b` | adapt | `343959bef1` | Predecessor 871b00907d is in origin/chase/t3-261114-all (#3332). The steer uuid comes from GOAT's Crypto service; registration sits after GOAT's memory admission and steer marker; a failed offer settles both. Test: ClaudeSteerAcceptance.test.ts |
| `cdbfae86cd` | adapt | `9048b9bf6e` | `claudeProcessExitFailure` lives beside the query runner errors in ClaudeAgentSdkQueryRunner.ts; test: ClaudeProcessExit.test.ts (GOAT adapter constructor, Deferred on the terminal instead of upstream's change signal) |
| `458a792087` | adapt | `6b8042a4b3` | The patch applied as is. Upstream `harness.until` and `awaitContinuation` become `awaitUntil` and continuation request counts. Test: ClaudeScheduledWakeup.test.ts |
| `86ae1747ad` | adapt | `7fb273b2fd` | The patch applied; the test is in ClaudeClearSession.test.ts |
| `7315c60b95` | adapt | `1812d512de` | Adapter latch tokens as upstream. GOAT's continuation service lacked the generic-failure `clearIfCurrent` branch, so it is added to GOAT's catch path. apps/server/src/orchestration-v2/ProviderContinuationService.ts (dispatch-failed handler) |
| `d20d535e32` | adapt | `22099c4c79` | The patch applied; the test is in ClaudeSubagentResume.test.ts |
| `694076dcf3` | adapt | `fa01058714` | Predecessor a50ebef78b is ported in this round. GOAT yields (memory admission, marker) between the first turn check and registration, so registration re-checks `steersClosed` with no yield before the set and settles the marker when refused |
| `00766e2c02` | not completed this round | | Ran out of context in this round; no design blocker found. ProviderSessionManager.ts is at its budget (3128), so the stall watch goes in its own module after a byte-identical move. GOAT has `getProviderControlContext`. The upstream test needs room in ProviderSessionManager.test.ts (6226 of 6326) or its own file |
| `c7618f6c10` | not completed this round | | Ran out of context in this round. 5 of 11 adapter hunks do not apply; the web hunk (TimelineAssistantRows.tsx) needs before/after captures under 3397/ |
| `9ce9b1fd41` | not completed this round | | Ran out of context in this round (13 files, ProviderInstallationGate plus maintenance runner) |
| `ccc9aaf10b` | not completed this round | | Its predecessor 7315c60b95 is ported in this round, so it is now portable (1354 lines upstream) |
| `7462f234e8` | not completed this round | | Its predecessor 458a792087 is ported in this round (publishedPendingBackgroundTasks now exists), so it is now portable |
| `d6e5f2e06f` | real defer: C4 negative case | | Unchanged: adds a persisted outbox effect variant; older-server decode needs negative coverage (apps/server/src/orchestration-v2/EffectOutbox.ts) |
| `5984bbb36e` | real defer: predecessor | | Needs d6e5f2e06f, still deferred |
| `86e2cb21c9` | real defer: C4 negative case | | Unchanged: SDK initialization rejection is swallowed upstream without negative coverage |
| `fdd54b942d` | real defer: C4 negative case | | Unchanged: process-kill safety; the upstream fixture sleeps and kills a PID read from a file |
| `e77384bf00` | real defer: design | | Unchanged: needs a failure-policy decision on suppressed transcript lookup failures |
| `d4b77d2448` | real defer: C4 negative case | | Unchanged: adds nativeItemId to the wire contract; older-client decode untested |

Counts for this round: 11 ported (all adapt), 0 take, 0 skipped, 5 not completed this round, 6 real defers. Not completed is not a deferral: those five rows have no blocker and go to the next round.

## Fail-first evidence (focused runs before each fix)

- 896e64f82d: `× resolves the native launcher path for a wrapper script`, `expected 'claudeAgent-native' to be undefined`.
- 543ee27fa8: `× forks a session from its original directory after the workspace root changes` (SDK: session not found in the project directory for the current cwd).
- 5badea5b45: `× Claude Stop-hook notices: hides a passive summary`, `expected [ 'Stop says: 40 scans, 0 findings' ] to deeply equal []`.
- a50ebef78b: `× settles a turn whose result echoes only a steer before the offer returns`, `expected [] to deeply equal [ 'pending', 'completed' ]`.
- cdbfae86cd: `expected 'Provider turn failed.' to include 'Claude Code process terminated by sig…'`.
- 458a792087: `Tests  7 failed | 3 passed (10)`, for example `the wakeup is still pending after the task notification's wake turn: expected false to be true`.
- 86ae1747ad: `expected 'native-thread-claude-wake' to equal 'cleared-native-session'`.
- 7315c60b95: `Tests  2 failed (2)` in ClaudeWakeDispatch.test.ts (`expected undefined to not equal undefined`). Without the service branch, the new ProviderContinuationService test never resolves.
- d20d535e32: `× reopens a completed background subagent that resumes while the root is idle`, `expected 1 to equal 2`.
- 694076dcf3: `× warns that a steer Claude never read be…`, `expected an undelivered-steer notice, got []`.

## Surfaces and contracts

Server-only changes plus two documentation paragraphs. No wire contract, persisted data, auth or permission change: `steer.updated` already exists in the provider event schema (871b00907d), the scheduled wakeup is published with the existing pending background task shape under the task id `claude-scheduled-wakeup`, and the process-exit failure fills existing failure fields. C4 older-peer cases: none apply. No UI change, so no captures.

## Gate (merged head 637128e173, after merging origin/chase/t3-261114-all at 295a0d7c66)

`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 VITEST_MAX_WORKERS=4 vp run check:changed`: unused patches, format, graphql, lint, agent context budget, agent surface audit and knip 2/2 pass. Two failures come from the integration branch, in files this lane does not change (`git diff origin/chase/t3-261114-all` is empty for both):

- typecheck: `apps/server/src/provider/Drivers/AntigravityDriver.ts:480:20 - error TS2304: Cannot find name 'processEnvironment'` (from the dev merge 2be9695078, #3207).
- knip 1/2: `Unused devDependencies (1) gt apps/web/package.json:123:6` (from the L14a i18n merge).

Because those steps fail, check:changed does not reach its test step. The affected tests were run directly: `vp test run src/orchestration-v2/Adapters/Claude src/orchestration-v2/ProviderContinuationService.test.ts src/provider/Drivers/Claude src/provider/ProviderInstanceRegistry.test.ts` plus the ThreadFork, ThreadMergeBack and ProviderSwitch integration tests: `Test Files 44 passed (44)`, `Tests 603 passed (603)`. `node scripts/goat-rename.ts --check`: `0 lines with T3 residue in 0 files, 0 dropped paths`.

NOT RUN: lane review (Codex pool at its weekly limit); check:changed's own test step (blocked by the two inherited failures above); CI (runs once on #3397).

Model: claude-opus-5-5 (anthropic) through the Codex harness in GOAT, high reasoning effort.
