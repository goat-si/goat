# SF2 runtime and storage

Lane base: `f82d2df4b0960eb39bd36e4100b72b6f2758c7d2`. The integration tip still exhibits all reported behaviors. The assigned rows are GOAT issues. Upstream commits cited below are prior art or antecedents.

## Prior art and compatibility

- **#3644 (C0).** Effect's SQL client holds a semaphore around nested savepoint ownership checks and the savepoint operation (`effect@4.1.3/src/sql/SqlClient.ts`, `makeWithTransaction`). GOAT's update service already serializes both update entry points, so document that the check permit protects its identity tokens against a check that reloads an equivalent state object.
- **#3544 (C2).** Upstream's [terminal trim](https://github.com/pingdotgg/t3code/commit/93cbca3fcbd54f33ec2f56ce70e302b44579b49c) puts SOS in the same state as PM and APC. The server replay sanitizer should classify SOS the same way, including its existing pending-data limit and handling of an ESC that interrupts the string.
- **#3538 (C4).** [Upstream's terminal manager](https://github.com/pingdotgg/t3code/blob/8a6342e761357feff652a57d3dd16f0c78026c25/apps/server/src/terminal/Manager.ts) also writes temporary history on the same filesystem before renaming it into place. Effect's `@effect/platform-node-shared/src/NodeFileSystem.ts` scopes that temporary directory with a removal finalizer wrapped in `orDie`. GOAT will keep the atomic rename and handle cleanup at the file boundary. Old clients on the new server continue to receive the same snapshots and notice text, and new clients on the old server still receive the same wire types with the old cleanup behavior. No log format change. Check that cleanup only removes directories with the generated temporary name, skips unrelated files and symlinks, and cannot block terminal open or overwrite the original on a failed rename.
- **#3610 (C2).** [Upstream's spawner](https://github.com/pingdotgg/t3code/commit/65e4272db1) limits in-flight checks to two and serializes by directory to protect libuv's pool. GOAT will retain both limits, bound admission and waiting, and report overload or timeout through the spawner's existing error type. A timed-out native check retains its slot until it actually finishes.
- **#3640 (C4).** Effect's `effect@4.1.3/src/sql/SqlClient.ts` turns rollback failure into a defect and its SQLite acquirer treats an already-ended transaction as clean. A genuine cleanup failure needs explicit reporting with the original typed body failure preserved. Old clients on the new server receive the existing error reason and trace id, and new clients on older servers may still receive an uncoded HTTP 500. No schema or grant changes. Check failed rollback, failed body alone, transaction already ended, and that the connection cannot leak uncommitted writes or reuse the failed transaction.
- **#3533 (decision).** [Upstream](https://github.com/pingdotgg/t3code/commit/a2a3388c5e) lets writes continue if a reader prevents the checkpoint worker from catching up. GOAT's production writer worker currently stops admitting new writes while the WAL exceeds the bound, and changing that requires choosing the server's disk budget.
- **#3670 (decision).** GOAT's `PullRequestService.withSharedProjectReads` shares an in-operation snapshot and drops it at the end. Its source-control provider registry caches settled remote discovery for a bounded interval while an inconclusive result is immediately eligible for retry. The media decision could reuse a cheaper fresh authorization predicate or share a snapshot with different revocation semantics.

## Verdicts

| GOAT row | Verdict | Commit |
| --- | --- | --- |
| [3640](https://github.com/goat-si/goat/issues/3640) | Adapted. Top-level SQLite rollback failure is logged, the original failure stays typed, and the next lease must complete cleanup before using the connection. The HTTP response keeps its existing reason and trace ID. | `df38b0244dfa9adc44906c53a67395141bc266f7` |
| [3610](https://github.com/goat-si/goat/issues/3610) | Adapted. Two native checks overall and one per directory, 32 waiting, five seconds per caller. A hung native check holds its slot and further checks of that directory fail promptly after the deadline. | `666ed1c83f08d4336076911bc651d7162d7e38c6` |
| [3644](https://github.com/goat-si/goat/issues/3644) | Adapted, C0. Identity checks rely on the existing check semaphore. Both scheduler and manual routes already hold it. | `a971d43086ad0e40ccba5fec0ac279446690afe5` |
| [3533](https://github.com/goat-si/goat/issues/3533) | Decision. `a2a3388c5e` is already adapted for the checkpoint worker in GOAT `3ecea04f193e48fac0685a718f6ae782f74911aa`. The production writer's pinned-WAL policy still applies. | — |
| [3538](https://github.com/goat-si/goat/issues/3538) | Adapted. Startup removes abandoned compaction directories of the generated shape under the owned terminal logs directory. Cleanup warnings preserve terminal open and the existing failed-compaction notice. | `5875fa3e47fc421baf201656955ff44f16b811b9` |
| [3544](https://github.com/goat-si/goat/issues/3544) | Adapted. ESC X enters the same bounded history state as PM and APC. Split ST and query-shaped payload are covered in replay tests. | `522a1ff9e6080c8e98d1559938d459e5048f2fd6` |
| [3670](https://github.com/goat-si/goat/issues/3670) | Decision with counts. A 30-image run through the media response and real PullRequestService with three fake project shells, an unresolved SSH project, and six requests in flight hit 30 listShells calls and 30 unknown-remote refinement calls. All 30 fixture fetches were authorized. | — |

Authored range `f82d2df4b0960eb39bd36e4100b72b6f2758c7d2..df38b0244dfa9adc44906c53a67395141bc266f7`. Zero clean upstream picks. Integrated `2c0e0002a996ec5d46c708919be5a43f579176fa` with one merge, `4fbddd1b25caf920d42501a7a29d2b2e5e3292c1`. Git reported the ort strategy and no conflicts. The merge had no lockfile change. Its tree was refreshed for a typecheck correction in the unpublished #3610 commit while retaining the exact integration parent.

## Open decisions

**#3533.** Keep the writer's current hard admission bound (32,768 frames or 128 MiB), adopt upstream's continued writes while a reader pins the WAL, or add a separate higher ceiling for pinned readers. Recommend the latter if the maintainer wants to improve availability. Keep a hard disk budget and distinguish the pinned-reader condition in diagnostics. The dev DB copy can pin the source because it reads the attached database inside a snapshot transaction (`apps/server/scripts/migrate-dev-db.ts:426`, `:440`). This choice costs zero wire fields and zero stored row changes. Continued writes can grow the WAL until the snapshot ends or the higher ceiling is hit.

**#3670.** Keep per-request reads, share a short-lived project snapshot, or give media a fresh membership lookup that can accept an authoritative match before probing unrelated remotes. Recommend the fresh lookup, retaining the current handling of uncertain matching remotes. A TTL over positive matches extends the time a removed project can authorize sending the GitHub token. Zero wire fields and stored rows are required for a fresh lookup or process-local cache. The fixture measures calls at the refinement boundary with fake probes and does not measure CLI time, database latency, or a real browser load.

## Newer upstream overlap

Compared `93cbca3fcbd..8a6342e7613` on each affected path. None of these commits were ported here.

- #3640, shared SQLite: `c0561c5c3d`, `0200dcf242`, `5ba3a84db4`. Auth handlers and tests: `39fcae5267`, `a2edd281df`, `4ee3b602fc`.
- #3538 and #3544, terminal Manager or contracts: `9795f45f23`, `69f8f59b51`, `dd7255d338`, `14f295e011`, `45dbb4436c`, `f0a3321354`, `8dba23e420`, `2b83dd0969`, `e101cae1b9`, `0720280c45`, `828200fc04`, `f6fd89b6f4`, `96051c630d`. No hits on the GOAT replay or history file modules.
- #3670, PullRequestService and ProjectService: `d427894aa1`, `86a9d9fb71`, `d2a894a247`, `f12e8206f5`, `f5ca0f9427`, `3f92b488db`, `071ae4e951`, `70be20493b`, `1a12c4afae`.
- #3610 spawner, #3644 managed update, and #3533 writer/checkpoint worker files had no hits. #3533 shares the SQLite client with #3640.

## Verification

- Failing first, all files run whole. `GOAT_TEST_TMP_GUARD=fail vp test run src/terminal/terminalHistoryReplay.test.ts` from `apps/server` exited 1 (3 SOS failures, 27 passed). `GOAT_TEST_TMP_GUARD=fail vp test run src/terminal/Manager.history.test.ts` exited 1 (2 cleanup failures, 6 passed). The combined guarded run of `src/terminal/Manager.history.test.ts src/process/NonBlockingSpawner.test.ts src/auth/http.test.ts` exited 1 (spawner got NotFound after mount release, auth got an empty 500 body; 11 passed, 3 native Linux cases skipped). `vp test run packages/shared/src/nodeSqliteRollback.test.ts` exited 1 (the typed-body recovery case died, the already-ended rollback case passed).
- `vp test run packages/shared/src/nodeSqliteRollback.test.ts packages/shared/src/nodeSqliteWriter.test.ts packages/shared/src/nodeSqliteClient.test.ts` with one temporary writer fault injection exited 0 (70 tests). The worker rejected an outside write after two rollback failures, then committed only the fresh write. The temporary fixture was removed.
- `GOAT_TEST_TMP_GUARD=fail vp test run src/pullRequest/PullRequestForkListing.test.ts` from `apps/server` with the temporary media counter fixture exited 0 (5 tests). The counter asserted 30 list reads, 30 unresolved-remote refinement calls, and authorization for all 30 images. The temporary fixture was removed.
- `git diff --check origin/chase/t3-261114-next3...HEAD` exited 0.

P1: #3538 and #3544, reopen a terminal with oversize saved history in a scratch project and observe retained text across web/desktop and mobile attachment. Use a scratch profile for #3640 if P1 exercises normal Revoke others recovery. Fault injection for rollback is covered by the HTTP and SQLite tests. #3610 has no new client entry point and needs Linux for native subprocess parity.

Final focused checks on `4fbddd1b25caf920d42501a7a29d2b2e5e3292c1`:

- From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run --reporter=verbose src/auth/http.test.ts src/process/NonBlockingSpawner.test.ts src/terminal/Manager.history.test.ts src/terminal/terminalHistoryReplay.test.ts src/hub/OpenCodexManagedUpdate.test.ts src/hub/ocxUpdateWindow.test.ts`. Exit 0. Six files: auth HTTP 4, spawner 1 plus 3 existing Linux-only skips, Manager history 8, replay 30, managed update 36, update window 6. 85 passed.
- `vp test run --reporter=verbose packages/shared/src/nodeSqliteRollback.test.ts packages/shared/src/nodeSqliteWriter.test.ts packages/shared/src/nodeSqliteClient.test.ts`. Exit 0. Three files: rollback 2, writer 27, client 40. 69 passed.
- The first changed-files gate found Effect diagnostic TS377016 in the spawner completion callback. Stopped that invocation through its own session (exit 130) after recording the diagnostic. The correction is in the spawner row commit.
- `vp run check:changed origin/chase/t3-261114-next3`. Exit 0 on the final lane head. Format, lint, both Knip passes, GraphQL, agent surface and context budget, and typecheck for 37 packages passed. Vitest selected 285 files: 282 passed and 3 skipped. 3,975 tests passed and 8 skipped, 0 failures.
- Plain push of `4fbddd1b25caf920d42501a7a29d2b2e5e3292c1` created `chase/t3-261114-next3-sf2`.

NOT RUN: Native Linux spawner parity on this macOS host (3 existing cases), the other 5 cases skipped by the local gate, legacy binaries, live media timing and hosted provider CLI probes, P1 real-client pass, PR #3700 CI, or full repo-wide suites.


## Fix round 1

Base `4fbddd1b25caf920d42501a7a29d2b2e5e3292c1`. The coordinator accepted P2-1, P2-2, P2-3 and P3 and approved SF2b. #3533 is deferred. The writer admission threshold stays in place and the issue stays open.

### Prior art and compatibility

- P2-1 (#3640). Effect 4.1.3 provides `SqlClient.make.onCommitFailure` for cleanup on the still-leased connection. Its `makeSqliteAcquirers` also quarantines after a failed cleanup and retries before lease reuse (`effect/src/sql/SqlClient.ts`). GOAT will route the hook through the rollback protection already shared by both drivers. Older and newer clients use the same SQL-backed requests and existing error formats in either direction. Deferred FK violations and rollback failure must leave the next read and transaction isolated. No migration or wire change.
- P2-2 (#3538). Effect's `NodeFileSystem.makeTempFileScoped` creates a generic prefix plus six generated characters. GOAT will give new writes a reserved prefix and leave all ambiguous legacy names alone, including empty directories and apparently valid legacy temp files. Old and new clients attach through the same terminal snapshot format. Older servers ignore the new names and new servers preserve ambiguous older names. The persisted history log format stays the same.
- P2-3 (#3538). GOAT's `PendingAttachmentSweepCursor.ts` uses Node's `opendir` with a 32-entry native buffer to bound cleanup memory. Terminal cleanup can use a scoped directory handle for the parent and a two-entry buffer for candidate inspection. Client and log compatibility follow P2-2. A candidate with a second entry must survive, and scanning must proceed to the rest of the parent.
- P3. The transaction cleanup notes in `devlog/_chase/010_fork_delta.md` track the original Effect migration. Replace references to the removed wrapper and preserve the reason for patching both read and transaction leases.
- SF2b (#3670). The existing `PullRequestService` uses fresh reads outside scoped bulk operations and refines SSH remotes with ambiguous web hosts. The media fast path will use an authoritative match from one fresh project read, with the existing refinement for uncertain matches and without retaining positive decisions. Old or new clients get the same media response on either server version, including older clients that supply only a cwd. Check project removal, host mismatch, unresolved remotes, cross-host identity, and the existing fail-closed paths. No storage/schema or API changes.

### Round verdicts and failing-first evidence

| Finding or row | Commit | Evidence before the fix |
| --- | --- | --- |
| P2-1 / #3640 | `a51cedd7502f18ec47ca8f709b13a0c35d520852` | `vp test run packages/shared/src/nodeSqliteRollback.test.ts` exited 1. Three failed and two passed. The next lease saw row 7 after a rejected COMMIT on both the direct and worker drivers. On the direct driver, the injected cleanup failure also failed to quarantine the next read. |
| P2-2 / #3538 | `ff1df5205fea8015db3ea71867b5304d7c877554` | `vp test run packages/shared/src/nodeSqliteRollback.test.ts apps/server/src/terminal/Manager.history.test.ts` exited 1. The provenance case listed a new GOAT temp dir still present and both ambiguous legacy dirs missing. The replacement prefix is reserved for new GOAT compactions. |
| P2-3 / #3538 | `ff00d58a8ac48aead41ffe0fd0372f474570c4e6` | From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run src/terminal/Manager.history.test.ts` exited 1. One failed and eight passed. The bounded-scan case observed zero directory cursors on the bulk-listing path. The new scan opens the parent with a 32-entry buffer, opens candidates with a two-entry buffer and stops at the second entry. |
| P3 | `d4ce607cb9239161b02612512881b04bf43167cb` | The stale-name check against `devlog/_chase/010_fork_delta.md` exited 1 and printed the removed hook at line 202. After the edit it exited 0. The new references resolve to transaction controls and both lease routes. |
| SF2b / #3670 | `dd3ba54cdcff65aff1a40d9a546447c857b12914` | From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run src/pullRequest/PullRequestForkListing.test.ts` exited 1. One failed and five passed. Thirty image requests did 30 reads, 30 unrelated remote refinements and 30 missing-identity lookups. Afterward they did 30 reads and zero of each unrelated lookup. Request 31 sent no token after project removal. A differently hosted SSH match still went through host verification. |

The final guarded server run used `GOAT_TEST_TMP_GUARD=fail vp test run --reporter=verbose src/terminal/Manager.history.test.ts src/pullRequest/PullRequestForkListing.test.ts src/pullRequest/PullRequestService.test.ts src/assets/sourceControlMediaCredential.test.ts src/auth/http.test.ts` from `apps/server`. Exit 0, 154 passed across five files: terminal history 9, fork listing 6, pull request service 127, media credential 8, auth HTTP 4.

This round adds five commits directly on the published lane head. Integration was not merged.

`vp test run --reporter=verbose packages/shared/src/nodeSqliteRollback.test.ts packages/shared/src/nodeSqliteClient.test.ts packages/shared/src/nodeSqliteWriter.test.ts` exited 0. 72 passed across three files: rollback 5, client 40, writer 27. `vp run --filter ./apps/server typecheck` and the shared package typecheck also exited 0.

P1: exercise terminal reopen after history compaction in a scratch project. For #3670, open private PR media from a listed project and exercise a fresh media fetch after removal in a scratch environment. The fixture covers no token on the very next fetch.

`vp run check:changed origin/chase/t3-261114-next3` exited 0 on `dd3ba54cdcff65aff1a40d9a546447c857b12914`. The integration merge base was `2c0e0002a996ec5d46c708919be5a43f579176fa`. 339 files passed and 3 were skipped, with 4,990 passed and 8 skipped tests. Both Knip passes, format, lint, GraphQL, agent surface audit and context budget, and typecheck for 42 packages passed. The plain push fast-forwarded the remote lane ref from `4fbddd1b25`.

NOT RUN: the eight existing gate skips, including three Linux-only spawner cases, legacy binaries, live media timing and hosting CLI probes, P1 real-client verification, PR #3700 CI, and full repo-wide suites.
