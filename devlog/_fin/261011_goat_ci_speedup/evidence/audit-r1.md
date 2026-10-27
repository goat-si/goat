# Independent plan audit: goat CI speedup

Read-only review of `devlog/_fin/261011_goat_ci_speedup/{000,010,020,030}*.md` against origin/dev source and the clean `codex/ci-speedup` worktree. No repository edits or full tunnel suite were run.

## Blockers

1. **High: extracted fixture code loses a required TypeScript diagnostic override.** Trigger: `010_phase1_test_split.md:18-20,32` moves `nativeScripts` and `makeProtocolFixture` into `*.fixture.ts`, but its only conditional config edit mentions `vite.config.ts`. `tsconfig.base.json:38,55-59` makes `preferSchemaOverJson` an error and disables it only for `*.test.ts(x)`. Both extracted helpers call `JSON.parse` inside Effects (`packages/ssh/src/tunnel.test.ts:212,3558-3565`). Impact: the phase-one typecheck gate can fail solely because of the move, inviting unrelated test-body rewrites contrary to `010:9-12`. Extend the test-only diagnostic override narrowly to these fixture files, or prove the extracted code is unaffected with the planned typecheck before locking the split plan.

2. **High: runner provisioning is not idempotent after partial or full success.** Trigger: `030_phase3_epyc_runners.md:11-14` calls the staged script idempotent, while `/tmp/goat-ci/epyc/add-goat-runners.sh:16-18` requires a fresh token before checking whether any requested unit is already active. A successful run deletes that token at `:42`, so the same command exits before its advertised skip path at `:24-26`. If registration wrote `.runner` but service setup failed, a retry skips config at `:28-34` and unconditionally runs `svc.sh install` at `:38`; it has no installed-unit recovery branch. Impact: a routine retry after a partial four-runner setup may stop before later runners are added. Check requested units before requiring a token, and handle configured/inactive, installed/inactive, and active states explicitly.

3. **High: the token handoff is not an executable, safe procedure.** Trigger: `030_phase3_epyc_runners.md:15-19` gives `gh api -X POST .../registration-token` and says its result is written to `~/goat-runner-setup/token`, but gives no `--jq .token`, no command that places it on the EPYC host expected by `/tmp/goat-ci/epyc/add-goat-runners.sh:14-18`, and no creation/permission command. The API command's normal output is a JSON object, whereas the script passes the entire whitespace-stripped file to `config.sh --token` at `:18,32-33`. The script deletes the token only on success at `:42`; `set -e` failures leave it behind. Impact: following the written command can fail registration or strand a credential. Provide a concrete raw-token transfer with mode 0600 and add cleanup on both success and error.

4. **High: the D6 decision rule cannot establish untraced loop incidence.** Trigger: `020_phase2_wait_reduction.md:66-76` measures elapsed time in an untraced run, but counts `WAIT_COUNT` only under `sh -x`. It then proposes a >=25% 20-iteration threshold while correctly saying a 20-count seen only under tracing is not evidence. The two relevant loops each sleep 0.1 s (`packages/ssh/src/tunnel.ts:1145-1151,1337-1341`), so tracing can itself change whether a short-lived PID lasts to 20 checks. Command exit time also includes work outside those loops (`packages/ssh/src/tunnel.test.ts:3641-3690`). Impact: the conditional production-builder amendment could be triggered by trace overhead or rejected without a valid untraced iteration count. Specify per-invocation correlation and an untraced counter or other direct, low-overhead observation before making that decision.

## Non-blocking notes

1. **Split coverage is sound, but the boundary wording is inaccurate.** `010_phase1_test_split.md:21-30,36-37` covers all 80 registration calls exactly once, expanding to 325 cases; the dynamic Vitest inventory also has 325 names in `tunnel.test.ts`. Several listed ranges start at `describe` wrappers (for example `packages/ssh/src/tunnel.test.ts:248,1035,1591,3050`) rather than test registration starts. State that these are wrapper/body source ranges and validate test registrations separately. The protocol wrapper begins at `:3356-3358`, outside the extracted helper range `:3359-3765`; each protocol test file needs the original title and `skipIf` condition. The runner-switch tests likewise need the wrapper from `:1857-1859`.

2. **The planned name verifier needs a concrete extraction step.** `010_phase1_test_split.md:48-53` says an inventory script filters ten new files, but names no script or exact command. `src/tunnel` also collects six `tunnel.mcpSession.test.ts` cases. The JSON reporter has per-test `fullName` and file path; filter to the ten named new files, sort, compare to `/tmp/goat-ci/baseline-names.txt`, and assert 325 passed/zero skipped. Static `vp test list` found only 32 names; dynamic collection found 331, of which 325 belong to the target file.

3. **The batching request count is misstated.** `020_phase2_wait_reduction.md:44-48` says twelve variants plus an ordinary input per archive key. The ordinary archive and mirror inputs are already among the twelve (`packages/ssh/src/tunnel.test.ts:251-268`); the existing two later native calls per key at `:278,285` can reuse those results. Build twelve requests, preserve the existing assertion order, and avoid duplicate generation.

4. **The sleep shim has a reachable activation path.** `020_phase2_wait_reduction.md:52-62` passes a PATH prefix through `runRunner` only for the final unowned-lock run. `packages/ssh/src/tunnel.test.ts:1597-1604,1632,1847-1851` passes PATH with `extendEnv: false`; the generated script invokes bare `sleep 1` (`packages/ssh/src/tunnel.ts:628-640`). Four shim calls before the fifth observation is the correct oracle. `import.meta.url` stays in the same directory after extraction (`tunnel.test.ts:195`), and `*.fixture.ts` does not match Vitest's test-file pattern; these do not block the plan.

5. **The phase order is coherent.** `000_plan.md:53-59` orders split, wait reduction, then runner/CI proof. `030_phase3_epyc_runners.md:27-34` includes a reachable `workflow_dispatch` path (`.github/workflows/goat-ci.yml:4-9`) and load/port-error observations. Compare the complete Test step after the split because SSH is followed by web (`goat-ci.yml:65-75`); a shorter SSH package run alone does not prove the job target.

## Verifier evidence

All commands below ran in `/Users/jun/Developer/goat.worktrees/ci-speedup`, with `PATH=/Users/jun/Developer/goat.worktrees/ci-speedup/node_modules/.bin:$PATH` for `vp` commands. Baseline state is clean and unchanged.

| Command                                                                                                                                                                    | Exit | Evidence                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ---------------------------------------------------------------------------------------------------------------- |
| `vp test --help`                                                                                                                                                           |    0 | `run`, `list`, `-t`, JSON reporter and outputFile exist.                                                         |
| `vp test list --config ../../vite.config.ts --dir . src/tunnel --json /tmp/goat-ci/audit-list.json`                                                                        |    0 | Static parser listed only 32; insufficient for parameterized inventory.                                          |
| `vp test list --config ../../vite.config.ts --dir . src/tunnel --no-staticParse --json /tmp/goat-ci/audit-list-dynamic.json`                                               |    0 | 331 names: 325 target + 6 MCP-session; target names exactly match the 325-line baseline list.                    |
| `vp test run --config ../../vite.config.ts --dir . src/tunnel -t 'does not hard-code a remote node engine range' --reporter=json --outputFile=/tmp/goat-ci/audit-one.json` |    0 | One target test passed; 330 others were skipped by `-t`. Confirms reporter schema without running the full file. |
| `vp run --filter @t3tools/ssh typecheck`                                                                                                                                   |    0 | Baseline pass, one unrelated suggestion in `runtimeArchiveGh.ts`.                                                |
| `vp lint packages/ssh/src`                                                                                                                                                 |    0 | Baseline pass with existing warnings.                                                                            |
| `vp exec knip --workspace packages/ssh`                                                                                                                                    |    0 | Baseline pass.                                                                                                   |
| `vp fmt --check packages/ssh/src`                                                                                                                                          |    0 | Baseline pass.                                                                                                   |
| `bash -n /tmp/goat-ci/epyc/add-goat-runners.sh`                                                                                                                            |    0 | Shell syntax valid; does not prove idempotence.                                                                  |
| `git diff --exit-code origin/dev -- packages/ssh/src/tunnel.ts`                                                                                                            |    0 | Clean worktree production script matches origin/dev.                                                             |
| `git status --short`                                                                                                                                                       |    0 | No tracked or untracked worktree changes.                                                                        |

No full suite, CI run, remote registration, or sudo operation was performed.

VERDICT: FAIL

## Round 2

### Blockers

1. **High: D6 still cannot compute the proposed cap-hit rate from the selected tests.** Trigger: `020_phase2_wait_reduction.md:66-75` counts a "loop invocation" as a maximal run of `sleep 0.1` records with the same PPID. Vitest runs test files in parallel by default (`vp test --help`: `--fileParallelism`, default true), so records from different shells can interleave and split one invocation. Grouping all records by PPID instead can merge separate invocations from the same shell: the launch script can call `wait_for_pid_exit` after stopping an old server and again after failed readiness (`packages/ssh/src/tunnel.ts:1215,1262`). The logger has only epoch-second timestamps and PPID (`/tmp/goat-ci/sleeplog/sleep:3-5`), with no loop boundary. In addition, the selected `tunnel.protocol-stop.test.ts` includes a parameterized `shim=true` path that sets `remotePath` to `/usr/bin:/bin` (`packages/ssh/src/tunnel.test.ts:5142-5148,5168-5188`), bypassing the prefixed sleep logger despite the claim at `020:66-70` that the fixture uses inherited PATH. Impact: the numerator and denominator of the >=25% threshold can both be wrong, leading to a false production-builder amendment or an incorrect decision to stop. Use an observation with explicit per-loop boundaries, or constrain and validate the measured cases so every relevant sleep is intercepted and each invocation is distinguishable. The shim does preserve the real `sleep 0.1` and avoids xtrace overhead; that part of round-one B4 is fixed.

### Non-blocking notes

1. **Round-one B1, B2, and B3 are folded.** `010_phase1_test_split.md:32-33` now has a concrete, conditional `tsconfig.base.json` override for `*.fixture.ts` diagnostics. `/tmp/goat-ci/epyc/add-goat-runners.sh:24-60` checks active/configured states before requiring a token and handles installed-but-inactive services; its EXIT trap at `:16` removes the token on failure or success. `030_phase3_epyc_runners.md:19-29` extracts the raw token with `--jq .token` and transfers it to the EPYC path under `umask 077`. Local script SHA-256 is `b2dd7522629fa8ce1bfebfcae74ea1a9cdf148ed66af16f2cc8064fedb4d0cb7`, matching the plan's prefix. Remote staging was not independently accessed in this leaf review.

2. **Round-one N1-N3 are folded.** `010_phase1_test_split.md:35-40` now distinguishes wrapper/body ranges from registration starts and explicitly recreates the `skipIf` wrappers. `010:51-56` names `/tmp/goat-ci/inventory.mjs`; its file filter excludes `tunnel.mcpSession.test.ts`, compares name multiplicities, and requires every target case passed (`inventory.mjs:6-24`). `020_phase2_wait_reduction.md:44-48` now builds exactly twelve requests and reuses the ordinary archive/mirror results.

3. **Inventory can pass with fewer than ten split files.** `/tmp/goat-ci/inventory.mjs:20-24` prints the file count but does not require it to equal ten. Complete 325-name coverage is the stronger correctness check; add a ten-file assertion if the parallel lane count is an acceptance criterion (`010_phase1_test_split.md:51-56`). This is non-blocking because the planned wall-time measurement also observes the speed outcome.

### Focused proof

| Command                                                                                      | Exit | Result                                                 |
| -------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------ |
| `node --check /tmp/goat-ci/inventory.mjs`                                                    |    0 | Parser valid.                                          |
| `node /tmp/goat-ci/inventory.mjs /tmp/tunnel-prof-base.json /tmp/goat-ci/baseline-names.txt` |    0 | `INVENTORY_OK`, 325 passed and no missing/extra names. |
| `bash -n /tmp/goat-ci/epyc/add-goat-runners.sh`                                              |    0 | Shell syntax valid.                                    |
| `rg -n 'sleep 0\.1' packages/ssh/src/tunnel.ts`                                              |    0 | Exactly lines 1150 and 1340.                           |
| `vp test --help` (filtered to `fileParallelism`)                                             |    0 | File parallelism defaults true.                        |
| `git status --short` in clean worktree                                                       |    0 | No repository edits.                                   |

No full tunnel suite, sudo command, or remote registration was run in Round 2.

VERDICT: FAIL

## Round 3

### Blockers

None in the two re-audited changes. The Round 2 D6 objection is resolved for the revised metric: `020_phase2_wait_reduction.md:73-84` totals all intercepted `sleep 0.1` calls per file, so no loop-boundary reconstruction is needed. It runs the files separately, resets the log for each, and explicitly reports the `shim=true` stop cases that bypass PATH (`:76-81`). The threshold is a planning trigger for a further P amendment, not authority to change production defaults immediately.

### Non-blocking note

`020_phase2_wait_reduction.md:73-74` calls `calls x 0.1 s` an upper bound on _loop time_. It is a nominal sleep-time budget; each loop also spends time in `kill`, shell work, the logging shim, and scheduling. Keep the reported unmeasured-case wall-time share alongside the measured budget when interpreting the 10% threshold. This precision does not change the intended decision: a material measured sleep budget triggers another plan amendment, and production bytes remain gated by the later verification.

### Focused proof

| Command                                                                                         | Exit | Result                                            |
| ----------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------- |
| `node /tmp/goat-ci/inventory.mjs /tmp/tunnel-prof-base.json /tmp/goat-ci/baseline-names.txt 1`  |    0 | `INVENTORY_OK`, 325 passed, one file.             |
| `node /tmp/goat-ci/inventory.mjs /tmp/tunnel-prof-base.json /tmp/goat-ci/baseline-names.txt 10` |    1 | `expected 10 files, got 1`; `INVENTORY_MISMATCH`. |
| `node --check /tmp/goat-ci/inventory.mjs`                                                       |    0 | Parser valid.                                     |
| `git status --short` in clean worktree                                                          |    0 | No repository edits.                              |

`010_phase1_test_split.md:51-56` passes the required expected file count of 10. `/tmp/goat-ci/inventory.mjs:22-26` enforces it and still requires the exact name multiset and all cases passed. No full tunnel suite was run.

VERDICT: PASS

## wp1 A

No drift or blocking issue for wp1. `git rev-parse HEAD` in `/Users/jun/Developer/goat.worktrees/ci-speedup` returned `d18f83e4e1f51497de72b39860117467be65cc85` (exit 0); `git status --porcelain=v1` was empty (exit 0). `git hash-object packages/ssh/src/tunnel.test.ts` matched `git rev-parse HEAD:packages/ssh/src/tunnel.test.ts` at `724060f9fb670449a60963b0f36484fbde2d903a` (both exit 0). `wc -l packages/ssh/src/tunnel.test.ts` returned 5467 (exit 0).

Registration check over the pinned file: 80 `it`/`test` registration starts, each in exactly one of the fifteen ranges in `010_phase1_test_split.md:21-30`; no missing or duplicate range membership (Node check exit 0). The seven top-level wrapper starts are at source lines 248, 1035, 1591, 1857, 2818, 3050, and 3356, consistent with the wrapper instructions at `010:35-40`. The prior dynamic inventory established that these registrations expand to 325 cases.

`010_phase1_test_split.md:7-64` is executable as the wp1 implementation plan: it specifies the three fixture modules, ten test files, exact source ranges and wrapper preservation, conditional config edits with activation checks, and focused verification. Its external baseline, registration list, and inventory verifier exist under `/tmp/goat-ci`. `/tmp/goat-ci/split/split.mjs` does not exist yet (`ls` exit 1); it is the one-off generator to be written during B, not a preexisting verifier or pinned input. No repository files were changed by this audit.

VERDICT: PASS

## wp2 A

No High or Critical blocker to implementing sections 1 and 2 at tree `8ab853b20dc4098863a2d53012d24b3d4b04fded` (`git rev-parse HEAD` exit 0; `git status --porcelain=v1` empty, exit 0). The wp2 stale-check locations match `packages/ssh/src/tunnel.fixture.ts:177-210` and `packages/ssh/src/tunnel.core.test.ts:52-103,1400-1437,1612-1656`.

### Non-blocking fixes

1. **Make shim setup explicit in the plan.** `020_phase2_wait_reduction.md:62-70` specifies the `bin/sleep` content, PATH handoff, and four-call assertion, but does not say to create its directory/file or `chmod` the script. The owning test already has a scoped temp root and `FileSystem` at `tunnel.core.test.ts:1614-1617`; create `bin/sleep` beneath that root, write the counting shim there, set executable mode (for example `0o700`), then prefix PATH only for `afterUnowned` at `:1650-1654`. Preserve `runShell`'s existing third `bytes` argument (`:1400`) and leave the concurrent calls at `:1626-1629` on the real PATH. A missing chmod would make the intended interception fail and the four-call oracle detect it.

2. **Report the actual D6 coverage limit with the conclusion.** `020_phase2_wait_reduction.md:89-106` promises the unmeasured `shim=true` share but gives no figure in the D6 result. In `/tmp/goat-ci/d6-protocol-stop.json`, those two cases sum to 15.078 s of the 79.432 s file wall time, **18.98%**. The saved calls and JSON reports support the measured budgets: stop 4 calls / 0.4 s / 0.50% (15/15 passed), acquisition 1 / 0.1 s / 0.13% (40/40), manager 3 / 0.3 s / 0.46% (5/5). Each report has `success: true` and one target file; the `*.calls` line counts are 4, 1, and 3. Thus the no-amendment decision is supported for intercepted loops, while the stop file's unmeasured cases remain a stated limit. No production change is needed for wp2's authorized sections 1 and 2.

### Equivalence checks

`020_phase2_wait_reduction.md:17-58` specifies twelve requests matching the three-by-four variant loop at `tunnel.core.test.ts:54-74`; the four later `nativeScripts(inputs[key])` calls at `:81,88` for archive/mirror are exact duplicates of each key's first request. Reusing those results preserves assertion order/count. `nativeScripts` currently imports `./tunnel.ts` from the same-directory fixture at `tunnel.fixture.ts:182-186`; the plan retains that native import and per-request builder expressions. A missing `selection` is omitted by JSON serialization and destructures to `undefined`, matching the current single-request script at `:184-186`. The generated production script bytes remain subject to the existing baseline assertion. `tunnel.ts:629-640` reclaims an unowned lock on observation five, after four bare `sleep 1` calls; the proposed call-count assertion is an appropriate interception check.

No tunnel suite was run for this read-only A review.

VERDICT: GO-WITH-FIXES (blockers=0)

## wp3 A

### Blocker

1. **High: the rerun gate can certify attempt 1 twice.** `030_phase3_epyc_runners.md:28-32` asks for `gh run rerun --job <goat-test>` and then `/tmp/goat-ci/ci-verify.sh` on both attempts. The CLI requires the numeric job database ID for `--job` (`gh run rerun --help`, exit 0); the current run's goat-test ID is available from the jobs API. More importantly, `ci-verify.sh:5-20` checks run status, conclusion, HEAD SHA, fixed SSH counts, and ten split-file lines, but never reads or asserts `.run_attempt` or a job attempt. On run 38141072402 it prints `CI_VERIFIED` (exit 0) while the run and goat-test job both report `run_attempt: 1`. Calling the same verifier again with that ID would pass without proving a second attempt occurred. Impact: the D8 flake/rerun criterion can be marked complete with only one execution. Resolve the goat-test numeric ID for the new run, invoke `gh run rerun <run-id> --job <id>`, and make the verifier accept/require the expected attempt number (1 then 2), selecting the matching latest goat-test job before checking its log.

### Non-blocking notes

1. **Rebase and push safety are sound as written, subject to the final remote-base check.** The clean worktree is at `55822a8f259c792b695bbc7b5f51fb1cbb73675e`, matching `origin/codex/ci-speedup`; `origin/dev` is `24d4ee846c4409f938ee76104d719ca82d8fe701`. Their merge base is `d18f83e4e1f51497de72b39860117467be65cc85`. `git diff --name-status d18f83e4e..origin/dev` lists documentation additions only, while `d18f83e4e..HEAD` lists SSH test files and `tsconfig.base.json`, so `030:21-22` has no path overlap. `030:28` limits force-with-lease to the agent-owned feature branch; `030:31-32` uses a non-forced push to `dev` only if its remote base still equals the rebased base. Fetch/compare the remote dev SHA immediately before that final push. The plan's `NEW` wording at `030:23` is stale because origin/dev already tracks the five unit documents; review and update those files after rebase rather than treating them as absent.

2. **The current CI proof is real but must be repeated at the rebased SHA.** Read-only `gh api .../actions/runners` exited 0 and listed goat-epyc-01..08 online with the expected labels. `gh api .../runs/38141072402/jobs` exited 0 and returned four successful jobs on runners 01..04 at SHA `55822a8f2`. `bash /tmp/goat-ci/ci-verify.sh 38141072402` exited 0: run completed successfully, SSH reported 17 files / 383 tests, and all ten split files were found. These hardcoded counts are an appropriate exact gate for this docs-only rebase, but the script does not adapt if the test inventory changes. The saved first-run log has no `EADDRINUSE` match (`rg -q`, exit 1).

3. **Credential scan: commit only the explicit allowlist.** Filename-only high-entropy/credential-shape scan of all `/tmp/goat-ci` returned `/tmp/goat-ci/orig.test.ts` (exit 0); it is **not** in `030:23-26`'s planned evidence list. The same scan over the exact planned `/tmp` evidence files and the unit docs returned no filenames (exit 1). A broad keyword scan finds words such as token/password in several planned prose/script files, so the `030:26` precommit check should search for credential-shaped values and inspect the staged file list, not reject every mention of those words. No values were printed or recorded in this review.

### Read-only proof

| Command                                                                            | Exit | Result                                                                     |
| ---------------------------------------------------------------------------------- | ---: | -------------------------------------------------------------------------- |
| `gh api repos/goat-si/goat/actions/runners` (projected names/status/labels)        |    0 | Eight online goat EPYC runners.                                            |
| `gh api repos/goat-si/goat/actions/runs/38141072402/jobs` (projected job metadata) |    0 | Four successful matrix jobs; goat-test attempt 1.                          |
| `bash /tmp/goat-ci/ci-verify.sh 38141072402`                                       |    0 | `CI_VERIFIED` for current pre-rebase HEAD and 17/383/10 SSH counts.        |
| `git merge-base HEAD origin/dev`                                                   |    0 | `d18f83e4e`; code/doc paths disjoint by `git diff --name-status` (exit 0). |
| `git ls-remote origin refs/heads/dev refs/heads/codex/ci-speedup`                  |    0 | Remote refs match the audited local refs.                                  |
| Credential-shape `rg -l` over `/tmp/goat-ci`                                       |    0 | Filename only: `/tmp/goat-ci/orig.test.ts`, excluded from commit list.     |
| Credential-shape `rg -l` over planned evidence allowlist                           |    1 | No matching filenames.                                                     |

No tests were run on this Mac and no repository or remote state was changed.

VERDICT: FAIL

## wp3 A round 2

### Blocker

1. **High: the new attempt assertion is non-fatal.** `/tmp/goat-ci/ci-verify.sh:10` chains four `[ ... ]` tests with `&&` under `set -e`. Bash does not exit when an early command in that AND-list is false. Reproduction: `bash -c 'set -e; false && echo unexpected; echo survived'` exited 0 and printed `survived`. Accordingly, `bash /tmp/goat-ci/ci-verify.sh 38141072402 2` printed `attempt=1` and continued to `/attempts/2/jobs`, where it finally failed with HTTP 404 (exit 1); the advertised attempt check did not reject it. If a requested attempt's job endpoint exists but the top-level run status/conclusion/SHA check is false, the script can still reach `CI_VERIFIED` when that attempt's goat-test job log passes. Impact: a failed or wrong-HEAD run may be certified as green. Make the four conditions an explicit `if ...; then ...; else exit 1; fi` or put `|| exit 1` after a grouped condition, then rerun both positive and negative verifier checks.

### Folded items and notes

1. `030_phase3_epyc_runners.md:30-36` now resolves a numeric goat-test job ID, invokes `gh run rerun <run-id> --job <job-id>`, and calls the verifier for attempts 1 and 2. `/tmp/goat-ci/ci-verify.sh:11-15` reads the named attempt's jobs and that attempt's successful goat-test log. `bash ... 38141072402 1` exited 0 with `CI_VERIFIED`; `bash ... 38141072402 2` exited 1 (for the wrong reason above). `gh api .../attempts/1/jobs` exited 0 and returned four successful jobs marked attempt 1. The verifier prints an `EADDRINUSE` count at `ci-verify.sh:20`; the plan should explicitly review a nonzero count before the final dev push, since printing alone does not fail the gate.

2. `030_phase3_epyc_runners.md:23-29,35-36` now treats the five unit docs as tracked MODIFYs, limits new evidence to an explicit allowlist, calls for a credential-shape scan of staged files, and requires a fetch plus exact remote-base equality before a non-forced dev push. These address round-one notes. For the credential check, scan the staged blobs (not merely a potentially different working-tree copy) and review `git diff --cached --name-only`; no files were staged during this review.

### Read-only proof

| Command                                                                                   | Exit | Result                                                            |
| ----------------------------------------------------------------------------------------- | ---: | ----------------------------------------------------------------- |
| `bash -n /tmp/goat-ci/ci-verify.sh`                                                       |    0 | Shell syntax valid.                                               |
| `bash /tmp/goat-ci/ci-verify.sh 38141072402 1`                                            |    0 | `CI_VERIFIED`, attempt 1 and 17/383/10 SSH counts.                |
| `bash /tmp/goat-ci/ci-verify.sh 38141072402 2`                                            |    1 | Continued past mismatch, then HTTP 404 for nonexistent attempt 2. |
| `bash -c 'set -e; false && echo unexpected; echo survived'`                               |    0 | Demonstrates non-fatal AND-list failure.                          |
| `gh api repos/goat-si/goat/actions/runs/38141072402/attempts/1/jobs` (projected metadata) |    0 | Four successful attempt-1 jobs.                                   |
| `git status --porcelain=v1` in ci-speedup worktree                                        |    0 | Clean; no local tests or repo edits.                              |

VERDICT: FAIL

## wp3 A round 3

No remaining High or Critical blocker in the re-audited verifier and wp3 step 4. `/tmp/goat-ci/ci-verify.sh:10-13` now uses an explicit `if`/`exit 1` for attempt, status, conclusion, and HEAD SHA; `:16-25` selects a successful goat-test job from the named attempt and rejects missing jobs, wrong fixed counts, non-ten split-file count, and any `EADDRINUSE` line. `030_phase3_epyc_runners.md:30-37` resolves a numeric job ID for the rerun, verifies attempts 1 and 2 separately, scans staged blobs with `git grep --cached`, and keeps the fetch/base-equality guard before a non-forced dev push. The current run has only attempt 1, so attempt-2 proof properly remains a B/C task.

Focused read-only checks (no local tests):

| Command                                            | Exit | Result                                                                                   |
| -------------------------------------------------- | ---: | ---------------------------------------------------------------------------------------- |
| `bash -n /tmp/goat-ci/ci-verify.sh`                |    0 | Shell syntax valid.                                                                      |
| `bash /tmp/goat-ci/ci-verify.sh 38141072402 1`     |    0 | `CI_VERIFIED`, attempt 1, 17 files, 383 tests, ten split files, zero `EADDRINUSE` lines. |
| `bash /tmp/goat-ci/ci-verify.sh 38141072402 2`     |    1 | `REJECT: run attempt/status/conclusion/sha mismatch` before job lookup.                  |
| `bash /tmp/goat-ci/ci-verify.sh 38134302415 1`     |    1 | Same explicit rejection for the other HEAD SHA.                                          |
| `git status --porcelain=v1` in ci-speedup worktree |    0 | Clean; no repository edits.                                                              |

VERDICT: PASS
