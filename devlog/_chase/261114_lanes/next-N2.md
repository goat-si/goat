# N2: Effect admission and SQLite (lane record)

Lane branch: `chase/t3-261114-n2-effect-sqlite`, from origin/dev `a11c5d644f`, merged with origin/dev at `c66dc0f1fd` (merge `1b5c3312ec`) and, after the review fix round, at `5688d26760` (merge `3c301acc44`) and `9fa40ff1f3` (merge `89694fe548`). Lane head `89694fe54867ef43bc3e2e6f1263fa8a6299a951`, pushed. The first READY was `718fe1f59e`; the review there was APPROVE WITH NITS with one P2, fixed below. Not merged anywhere yet; the coordinator merges reviewed lane heads into `chase/t3-261114-next`. Host pen-macbookair (the plan named pen-macmini; this thread ran on pen-macbookair). Class: not C4. The rows change in-process scheduling of effect executions and how SQLite results and checkpoints move between threads. No wire contract, schema, migration, stored data, permission, release step or dependency changes (no lockfile change).

## Rows

| card | upstream     | ruling                                  | GOAT commit  | summary                                                                            |
| ---- | ------------ | --------------------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| L80  | `cbc38a1b0f` | C10 B                                   | `47236ccdb8` | fix(server): one unresponsive provider no longer stalls every thread's effects     |
| L25  | `a2a3388c5e` | C2 B, test failed; keep-checkpoint-only | `38535fb9a5` | fix(server): keep writes moving while readers pin the WAL (checkpoint-worker mode) |
| L25  | `daed91f264` | C2 B, measured                          | `be08fde9e5` | fix(shared): batch SQLite worker result transfers                                  |

Other commits:

- `3566577acb` refactor(shared): move readSafeSqliteInteger beside the checkpoint worker helpers. Verbatim move-out of 5 lines into sqliteCheckpointWorker.ts, so nodeSqliteClient.ts (1304 of its 1307 entry after a2a3388c5e) had room for daed91f264.
- `718fe1f59e` test(server): the EffectExecutionFences test fake answers detach. `mockExecution` in EffectWorker.testkit.ts (used by EffectWorker.test.ts and FoundationPersistence.test.ts) gains `detach: () => Effect.succeed(false)`; the first gate's typecheck caught it. No expectation changes.
- `42a3eaa0e3` chore(budgets): lower nodeSqliteClient.ts to its real length (1307 → 1306).

EffectWorker.ts was not changed, so it needed no move-out: the detach lives in the daemon (EffectWorkerDaemon.ts), the fences (EffectExecutionFences.ts) and runClaim (OwnedEffectDeadline.ts).

## Decisions

- **C10 B, the cap.** After 30 seconds (upstream's `EFFECT_WORKER_SLOT_WAIT`) a daemon slot asks the fences to detach the claim it is running. A detached claim keeps its admission (it still fences its own thread, and drain still waits for it) but stops counting toward its lane's capacity, so the slot claims other work while the execution runs on in the daemon's scope and settles its row later. **Cap: each lane detaches at most as many executions as it has slots**: general 4 (the daemon's concurrency), start max(2, floor(cores / 2)) (4 on an 8-core Mac), control 1, cleanup 1; 10 on an 8-core Mac. Reason: the server already sizes each lane for its slot count of concurrent provider calls, so a lane at its cap runs at most twice that many, and the lanes stay independent (hung starts cannot use up the control lane's detach, so interrupts and approvals keep moving). At the cap the slot keeps waiting on its execution and rechecks every 30 seconds; the next effect stays `pending` in the durable outbox with no attempt used, so nothing in memory grows and nothing is dropped. The test at the cap (EffectWorker.startLane.test.ts, "a start waits pending once each start slot has detached one hung start, then runs") hangs twice the start slots, checks another thread's start is still `pending` with `attemptCount` 0 an hour later, then settles one hung start and sees the waiting one run. With the cap removed (detach cap Infinity) that test fails at the "waits pending" assertion (EffectWorker.startLane.test.ts:743, `expected false to be true`).
- **C10, how the slot learns its claim.** runClaim records the admitted claim in a `ClaimSlot` reference the daemon provides per attempt; the daemon forks the attempt with `startImmediately` so an attempt that finishes in time runs exactly as before (without it, "runs independent cleanup while four general effects remain held" failed on the extra scheduler hop).
- **C2 B, a2a3388c5e.** The GOAT test with a reader pinning the WAL (upstream's two tests) failed on dev, so the retry is ported: the checkpoint worker reports a WAL pinned by a reader as not blocked and keeps retrying a WAL past its limits with admission open, a failed TRUNCATE no longer holds writes, and the parent holds writes past the frame ceiling only until the worker judges the WAL. GOAT keeps its busy-error guard around TRUNCATE (`finishTruncate`), dropping only the `busy` result upstream dropped.
- **C2, which mode the port reaches.** Upstream's pinned-WAL tests use checkpoint-worker mode (a main-thread writer plus the checkpoint worker). Production opens statev2 with `writerWorker: true` (apps/server/src/persistence/Sqlite.ts:116-121), where the checkpoint worker never starts and the writer worker's own `maintain()` (packages/shared/src/sqliteWriterWorkerSource.ts:105, :127, :163-165) holds mutations past 32,768 frames or `journal_size_limit`, pinned reader or not. Two existing tests assert that pause (nodeSqliteWriter.test.ts:723 and :823). I raised this as decision `decision:5904e7d5-915e-4e32-b418-29351cb8b092`; the coordinator answered keep-checkpoint-only, quoted below. The writer worker and those two tests are unchanged.
- **C2 B, daed91f264.** Measured before porting (see Measurements): a measurable gain, so ported to both of GOAT's query workers (upstream has one worker source; GOAT has separate reader and writer sources) through a shared `sqliteRowBatches.ts`. Batches are at most 16,384 rows or 8 MiB with one unacknowledged; a statement that fails mid-iteration leaves the prepare cache.

## Review fix round (2026-11-16)

Fresh review at `718fe1f59e`: APPROVE WITH NITS, one P2 (reproduced by the reviewer). One commit per ruling, test first:

| ruling  | GOAT commit  | summary                                                                                             |
| ------- | ------------ | --------------------------------------------------------------------------------------------------- |
| N2-P2-1 | `0bd10c4041` | fix(server): a hung start keeps counting under critical host pressure                               |
| N2-P3-2 | `c4ab09e1c4` | fix(server): stopping the effect daemon interrupts in-flight executions together                    |
| N2-P3-5 | `6169f71988` | test(server): a detached execution settles its row and frees its thread; detach in the general lane |
| N2-P3-4 | `915783ed9a` | fix(server): detached executions log their thread, and once more when they settle                   |
| N2-P3-4 | `97717d81d0` | test(server): the daemon log test provides its layers in one call (TS377033 failed typecheck)       |
| N2-P3-3 | record       | the three sentences under Known limits                                                              |
| N2-P3-1 | goat#3542    | the flaky writer test: cause corrected to "source not established", issue filed, test unchanged     |

- **N2-P2-1, a GOAT difference from upstream cbc38a1b0f.** Under critical host pressure GOAT admits one provider start at a time (#2446, EffectOutbox.ts sampleStartCapacity). A detached start now keeps counting toward the start lane whenever the sampled start capacity is below the lane's slot count (`EffectExecutionFences.snapshotWith`, which now receives `startSlots` beside `startCapacity`), for any reduced capacity. Reason: upstream has no host-pressure start limit, and without this every 30 seconds another start ran beside a hung one, up to 1 + start slots, on a machine already struggling. Under normal pressure detach works as in the first READY. Test: EffectWorker.startLane.test.ts "a hung start keeps counting under critical pressure, so a second start stays pending" (critical monitor, a start that never returns, the second start `pending` with `attemptCount` 0 after an hour of TestClock); the normal-pressure cap test still passes.
- **N2-P3-2.** Attempts now fork into a child scope with the parallel finalizer strategy (`Scope.fork(scope, "parallel")`), so the effectWorker shutdown phase interrupts in-flight executions together, as dev's `Effect.all` did. Test: EffectWorkerDaemon.test.ts "stopping the daemon interrupts its in-flight executions together": two hung executions whose teardowns each wait up to a minute (TestClock) for the other's; both must see the other interrupted.
- **N2-P3-5.** The cap test now checks that the released detached start's row reaches `succeeded` and that its thread then runs its next effect. New EffectWorkerDaemon.test.ts "a hung general effect detaches; another thread runs, its own thread waits, then it settles" (general lane, concurrency 1). Both pass at the head; with detach refused (cap 0) the general-lane test fails (`expected false to be true`).
- **N2-P3-4.** The detach warning `orchestration-v2.effect-execution-detached` carries `threadId`. When a detached execution settles, `retireJoined` logs `orchestration-v2.effect-execution-detached-settled` once (Info) with effectId, effectType, threadId, outcome (`executed`, `cancelled`, `failed`, `interrupted`) and `elapsedMs` since the execution began. Log lines only; no thread item and no wire change. Asserted in the general-lane test.

Fail-first (code before each fix):

- N2-P2-1: `AssertionError: a second start ran beside a hung one under critical pressure: expected false to be true`.
- N2-P3-2: `AssertionError: the daemon stopped its executions one at a time: expected { a: true, b: false } to deeply equal { a: true, b: true }`. A first version of the test, whose teardowns waited for each other without a bound, hung instead of failing; it was stopped by its own PIDs (descendants of my command, cwd this worktree) and reworked with the bounded wait.
- N2-P3-4: `AssertionError: expected [ Array(1) ] to deeply equal [ …(2) ]` (no settle line yet).

## Coordinator decision (C2), verbatim

"Coordinator decision, 2026-11-16, lane N2, row L25 a2a3388c5e (ruling C2 B): KEEP-CHECKPOINT-ONLY. C2 B said to port the retry where a test with a reader pinning the WAL fails; that is the checkpoint-worker mode (main-thread writer plus checkpoint worker), and 38535fb9a5 stays as ported for that mode with upstream's pinned-WAL tests. The production path (apps/server/src/persistence/Sqlite.ts opens statev2 with writerWorker: true) is NOT changed in this lane: there GOAT's writer worker holds mutations while the WAL is past 32,768 frames or journal_size_limit and resumes after a truncate, by design, and the two existing tests that assert it (nodeSqliteWriter.test.ts:723 and :823) keep their expectations. No rule 3 authorisation is given for them. Record under Known limits, in plain words: on a GOAT server a long outside read transaction on statev2 (sqlite3, a backup, a snapshot copy) can pause server writes once the WAL passes its limit, until that reader closes; upstream's fix for this does not reach GOAT's writer worker. File one goat issue for that trade-off (write pause against WAL growth for the writer worker), with the two test names, the lines in sqliteWriterWorkerSource.ts, upstream a2a3388c5e, and the question whether GOAT's own read-only snapshot of a live database (vp run migrate-dev-db, the dev seed) can be such a reader; report its number. The #3176 row says ported for checkpoint-worker mode, with the issue number. C10 and daed91f264 are unaffected."

Filed as goat-si/goat#3533 (write pause against WAL growth for the writer worker, with the open question about `vp run migrate-dev-db` and the dev seed as such a reader).

## Measurements (daed91f264)

/tmp/n2/n2-bench.ts on pen-macbookair: a WAL database with 3,000 rows of 16 KiB text and 200,000 rows of two integers, read through `SqliteClient.layer({ readerWorker: true, writerWorker: true })`, once on the reader (`readOnly`) and once on the writer. Per case: one warm-up, then the median of 7 runs of wall time and of the longest main-thread stall (largest gap between 1 ms timer ticks during the query). Three runs each:

| case                 | dev wall ms       | dev stall ms     | port wall ms       | port stall ms |
| -------------------- | ----------------- | ---------------- | ------------------ | ------------- |
| reader 3000 × 16 KiB | 22.1, 22.4, 22.7  | 5.9, 5.7, 5.9    | 21.3, 20.8, 20.9   | 3.9, 3.4, 3.1 |
| reader 200k narrow   | 93.3, 92.8, 92.6  | 26.5, 26.3, 25.6 | 96.4, 99.6, 97.3   | 3.2, 3.2, 3.4 |
| writer 3000 × 16 KiB | 26.5, 25.4, 25.2  | 8.4, 7.7, 7.5    | 21.9, 20.5, 21.1   | 3.1, 3.4, 2.9 |
| writer 200k narrow   | 93.0, 109.5, 94.7 | 26.5, 32.5, 28.2 | 100.7, 100.7, 99.8 | 4.1, 4.4, 4.3 |

The gain is the main-thread stall: about 26-32 ms to 3-4 ms on a 200k-row read, which is time no other client request, WebSocket push or effect runs. Wall time for the narrow read rises about 5% (iterate plus one handshake per batch); the wide read is slightly faster.

## Upstream tests carried

- L80: "starts another thread's turn while every worker holds a start that never returns", in EffectWorker.startLane.test.ts (GOAT's start-lane tests) instead of FoundationPersistence.test.ts (95 lines under its budget, and the cap test would not fit too). Adapted: GOAT routes `provider-turn.start` to its start lane, so the test hangs one start per start slot (max(2, cores / 2)) instead of the daemon's concurrency. Added: the test at the cap above.
- a2a3388c5e: "keeps admitting writes while an outside read transaction pins the WAL" and "keeps admitting writes while a reader stops TRUNCATE, then resets the WAL", in the new nodeSqliteClient.pinnedWal.test.ts because nodeSqliteClient.test.ts is at its entry (1299 of 1299). It records the checkpoint worker by its source instead of `startedWorkers.at(-1)`.
- daed91f264: "batches worker results without losing rows (reader=false|true)" and "reuses a worker query after an iterator constraint failure", in the new nodeSqliteClient.rowBatches.test.ts (same budget reason), with GOAT's `writerWorker`/`readerWorker` options.
- Left out: nothing of upstream's diffs. Upstream's `ATTR_DB_*` and single worker source have no GOAT counterpart to edit.

## Existing tests touched (rule 3)

No expectation in an existing dev test changed. daed91f264 makes the workers call `StatementSync.iterate` instead of `StatementSync.all`, so three GOAT fault and timing hooks move to the call the worker now makes; their assertions are unchanged:

- packages/shared/src/nodeSqliteClient.test.ts:46: `config.point === "statement" ? "all" : "prepare"` → `? "iterate" : "prepare"`.
- packages/shared/src/nodeSqliteWriter.testFixtures.ts:100: `=== "execute" ? "all" : "prepare"` → `? "iterate" : "prepare"`.
- packages/shared/src/nodeSqliteWriter.test.ts:684: `[sqlite.StatementSync.prototype, "all"]` → `"iterate"`.

Without the move, 10 recovery tests time out because the injected failure is never raised (for example "retries only WAL recovery at writer execute without losing values mode", "bounds reader recovery retries and preserves the final lock error").

## Fail-first (code before each fix)

- L80: `AssertionError: another thread's provider-turn.start never ran behind starts that never return: expected false to be true` (EffectWorker.startLane.test.ts, 1 failed).
- a2a3388c5e: `write 127 is held by admission while an outside reader pins the WAL` and `a write after the failed TRUNCATE is held by admission while an outside reader pins the WAL` (2 failed).
- daed91f264: `expected 1 to be above 1` for reader=false and reader=true (one message carried the whole result); "reuses a worker query after an iterator constraint failure" passes on dev (GOAT used `all`), kept as the guard for the iterator path.

## Gate

- `718fe1f59e` (pen-macbookair, after merging origin/dev at `c66dc0f1fd`, merge `1b5c3312ec`): `node scripts/goat-rename.ts --check` 0 (0 lines with T3 residue); `set -o pipefail; vp run check:changed` exit 0: format, lint, graphql, agent surface audit, agent context budget, knip 1/2 and 2/2, typecheck (38 packages) pass; test 238 files, 3288 passed, 5 skipped, 0 failed. The agent surface audit and context budget are part of that run and pass; no agent-visible text changed.
- The first gate on `42a3eaa0e3` + merge (`1b5c3312ec`) failed typecheck: `mockExecution` lacked `detach` (4 errors in EffectWorker.test.ts:371/:440/:509 and FoundationPersistence.test.ts:1795), fixed in `718fe1f59e`. That run also had one test failure, nodeSqliteWriter.test.ts "reports sustained pinned-reader admission pressure with frame counts and recovery" (`persistent refusals must report degradation once: expected 2 to equal 1`, 23.5 s in the run). It runs in writer-worker mode, which none of this lane's commits change except the row path (backpressure replies carry no rows). It passed alone 3 times and 5 times under 10 busy-loop CPU load processes (stopped by their captured PIDs), and passed in the second gate. The test counts every Warn line it captures. The source of the second warning is not established: this record first blamed the 10-second request watchdog, but the review showed no send is in flight when the test advances the clock, and its stall probes did not reproduce the other candidates. Filed as goat-si/goat#3542 with the review's analysis and proposed fix (count only "SQLite writer WAL admission degraded" lines, print the warning texts in the assertion); the test is unchanged in this lane.
- Before the gate, `vp test run src/orchestration-v2` (apps/server) on `42a3eaa0e3`: 413 files, 4217 passed.
- One stale vitest from another worktree (chase-t3-261114-desktop, PIDs 259 and 1617, running 35 hours) was left alone.
- origin/dev moved to `330c1837f6` after that gate; merged later at `5688d26760`.
- `89694fe548` (pen-macbookair, review fix round, after merging origin/dev at `9fa40ff1f3`): `node scripts/goat-rename.ts --check` 0; `set -o pipefail; vp run check:changed` exit 0: format, lint, graphql, agent surface audit, agent context budget, knip 1/2 and 2/2, typecheck (38 packages) pass; test 325 files, 4370 passed, 5 skipped, 0 failed. An earlier run on `3c301acc44` failed typecheck on an Effect diagnostic warning in the new daemon test (chained `Effect.provide`, TS377033), fixed in `97717d81d0`; that run was stopped through its own session. A run started while lane N6's vitest held the slot was stopped at once through its own session; the gate above ran after N6 finished. origin/dev moved to `dfc7a597d1` after this gate; not merged.

## Surfaces

- Effect admission: server only. Every client (web, desktop, mobile) and every agent path (MCP tools, scheduled tasks) reaches effects through the same outbox and daemon, so all see a hung provider stop blocking other threads after 30 seconds. Providers: provider-neutral; the executor is shared by all adapters.
- SQLite: server only. Row batching reaches every database opened with reader or writer workers (statev2 in production). The a2a3388c5e retry reaches only databases opened in checkpoint-worker mode, which production does not use (goat-si/goat#3533). No wire or settings change.
- Real client: not run (see NOT RUN).

## Code budgets

`git diff origin/dev -- oxlint-plugin-goat/code-budgets.json` lowers only nodeSqliteClient.ts (1307 → 1306). No entry raised. Files changed without an entry stay under 1000 lines: EffectWorkerDaemon.ts 157, EffectExecutionFences.ts 200, OwnedEffectDeadline.ts 108, EffectOutbox.ts 866 (869 before), nodeSqliteWriter.ts 399, and EffectWorker.startLane.test.ts 863 (611 on dev; it holds GOAT's start-lane tests, so the carried upstream test, the cap test and the critical-pressure test went there; the daemon tests went to the new EffectWorkerDaemon.test.ts). New files: sqliteRowBatches.ts, nodeSqliteClient.pinnedWal.test.ts, nodeSqliteClient.rowBatches.test.ts, EffectWorkerDaemon.test.ts, all under 200 lines. No test file moved or renamed, so scripts/lib/goat-rename needed nothing.

## Note for N3

57cd05904d (lane N3, Effect 4.1) adds `driver: "node:sqlite"` to Client.make in nodeSqliteClient.ts, and this lane leaves that file at exactly its budget (1306), so N3 opens with a move-out there after this lane merges.

## Known limits

- On a GOAT server, a long outside read transaction on statev2 (sqlite3, a backup, a snapshot copy) can pause server writes once the WAL passes its limit, until that reader closes. Upstream's fix for this (a2a3388c5e) does not reach GOAT's writer worker, which production uses; it is ported only for the checkpoint-worker mode. Tracked in goat-si/goat#3533.
- One stuck provider can still take a lane's whole detach cap: effects do not carry their provider, so without per-provider lanes (option C, not taken) hung starts on one provider across several threads use the start lane's detaches, after which other providers' starts wait as before. The cap is per lane, so a hung start never takes the control or cleanup lane's detach.
- For the first 30 seconds a hung execution still fills its slot, as before.
- Detached executions keep their provider resources until they settle or the daemon stops. Under critical host pressure a detached start keeps counting, so the start lane still admits one start at a time (N2-P2-1).
- Slow but healthy effects detach too, such as a large checkpoint.capture, a title generation inside its 120-second budget, or delegated-tasks.stop at its own 30-second timeout, so the general lane can run 8 effects where it ran 4 (more git processes on a busy machine), and these use the lane's detach capacity.
- A hang outside runClaim never detaches: the claim, the cancellation re-read and settlement keep the slot, because the slot learns its claim only after the fences admit the execution; upstream moves on regardless, but GOAT's choice is the safer one, since those steps own the outbox row and a slot that moved on could leave a claimed row with no owner.
- The a2a3388c5e port reaches no shipped code: the checkpoint-worker mode it fixes runs only in tests, because the only shipped caller (apps/server/src/persistence/Sqlite.ts) sets writerWorker: true, so makeConnection and startCheckpointWorker never run there.
- A detached execution is interrupted when the daemon's scope closes (server shutdown), as upstream.
- Row batching bounds each message, not the whole result: the parent still assembles the full result in memory, as before.

## NOT RUN

- Real-client pass: no visible change; the behaviour is covered by the daemon tests with a hung executor.
- A real provider that never answers (covered by the executor stub that never returns).
- Measurement on a production-sized statev2 database; the benchmark uses synthetic rows.
- Full suite (`ci:full`).
