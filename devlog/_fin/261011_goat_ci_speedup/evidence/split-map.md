# `packages/ssh/src/tunnel.test.ts` split map

Source paths below are relative to `/Users/jun/Developer/goat`. Counts come from parsed test registration calls in `packages/ssh/src/tunnel.test.ts`; times are sums of **238 individually named tunnel rows** in `/tmp/goat-ci/ci-test-durations.tsv` matched to their source title templates. The TSV's `1221.11s / 325 tests` file header is at line 1. Its named rows omit 87 cases, so group times are measured lower bounds, not exact complete runtimes; named tunnel rows sum to 1216.388s (4.722s below the file header). Eight other named rows belong to other SSH test files and were excluded. No test was run for this map.

## A. Top-level declarations

All 22 declarations are before the first `describe`; there are none between the seven top-level `describe` blocks. Imports are at `tunnel.test.ts:1-27`, including the baseline JSON fixture at line 27. Group keys: **S** scripts (248), **R** runtime preparation (1035), **A** archive runner (1591), **I** install before switch (1857), **B** bundled acquisition (2818), **O** stop ownership (3050), **P** protocol selection (3356). The table records identifier use within each group, including generated script text and test bodies.

| Lines   | Declaration                                               | Used by             |
| ------- | --------------------------------------------------------- | ------------------- |
| 32      | `remoteShell`                                             | R, A, I, B, O, P    |
| 33      | `remoteShellCommand`                                      | R, I, B, P          |
| 35      | `TEST_NODE_ENGINE_RANGE`                                  | S, P                |
| 37-52   | `makeSuccessfulProcess`                                   | S, R, I, B, P       |
| 54-62   | `makeDelayedSuccessfulProcess`                            | S                   |
| 64-88   | `makeRunningProcess`                                      | S, R, I, P          |
| 90-92   | `testHttpClient`                                          | S, R, I, P          |
| 94      | `hangingHttpClient`                                       | S                   |
| 96-102  | `testNetService`                                          | S, R, I, P          |
| 104-106 | `commandArgs`                                             | S, R, I             |
| 108     | `ARCHIVE`                                                 | S, R, A, I, B, O, P |
| 110     | `PROTOCOL_ARCHIVE`                                        | S, I                |
| 111-113 | `NODE_SCRIPT`                                             | S                   |
| 115-120 | `uploadTarget`                                            | S, R, I, B, P       |
| 121     | `platform`                                                | S, R, A, I, B, P    |
| 122     | `arch`                                                    | S, R, A, I, B, P    |
| 123     | `encoder`                                                 | S, R, I, O, P       |
| 125-148 | `makeUploadFixture`                                       | R                   |
| 150-157 | `recordSpans`                                             | R                   |
| 160-187 | `makeProtocolTestSpawner`                                 | S, I                |
| 190-223 | `nativeScripts` (inline Node script template at 196-198)  | S, R, A, I, P       |
| 226-246 | `installArchivePsDouble` (inline shell script at 236-242) | R, I, P             |

The two large blocks have additional **describe-local** declarations that must be extracted before their tests can be divided: `stateKey`, `oldVersion`, `nextVersion`, `shell`, `executable`, and `fixture` at `tunnel.test.ts:1860-2176`; `protocolExecutable` and `makeProtocolFixture` (including their inline Node server script) at `tunnel.test.ts:3359-3765`. These are not module-level mutable state.

## B. Top-level describe blocks

`each` column gives every parameterized call's start line and expansion count; remaining registration calls are single tests. The counts include `it.live.each`, `it.effect.each`, and `it.effect.skipIf` registrations, with skipped-on-Windows cases still counted as registrations.

| Block (`tunnel.test.ts` lines)                 |   Tests | `.each` expansions                                                                                                                                                                                                                          | Matched CI seconds |
| ---------------------------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------------: |
| `ssh tunnel scripts` (248-1033)                |      23 | 745:2, 828:2, 929:2                                                                                                                                                                                                                         |             13.963 |
| `runtime preparation` (1035-1586)              |      34 | 1036:27, 1338:4                                                                                                                                                                                                                             |             21.076 |
| `archive runner script` (1591-1855)            |       5 | none                                                                                                                                                                                                                                        |              8.465 |
| `install before runner switch` (1857-2816)     |      38 | 2178:7, 2394:4, 2477:8, 2684:2, 2713:2, 2749:8                                                                                                                                                                                              |            133.863 |
| `bundled runtime acquisition` (2818-3048)      |      14 | 2819:14                                                                                                                                                                                                                                     |              3.898 |
| `remote stop invocation ownership` (3050-3354) |      31 | 3053:28, 3230:3                                                                                                                                                                                                                             |              1.457 |
| `SSH runtime protocol selection` (3356-5467)   |     180 | 3767:6, 3802:3, 3828:4, 3910:11, 3972:14, 4082:5, 4129:5, 4176:5, 4210:5, 4243:4, 4370:2, 4421:6, 4477:3, 4546:2, 4591:3, 4638:21, 4675:3, 4696:12, 4749:6, 4775:9, 4802:3, 4820:6, 4959:2, 5049:8, 5142:4, 5238:2, 5351:3, 5368:15, 5406:3 |           1033.666 |
| **Total**                                      | **325** |                                                                                                                                                                                                                                             |       **1216.388** |

The protocol block's computed `.flatMap` expansions are based on the literal arrays at `tunnel.test.ts:3767`, `3828`, `4176`, `4210`, `4638`, `4696`, `4749`, `4775`, `4820`, `5049`, `5142`, and `5368`. There are 80 test registration calls overall, expanded to 325 cases. The TSV does not contain individual durations for many fast registrations, especially at `tunnel.test.ts:248-1586`, `2818-3354`.

## C. Concurrency hazards

- No top-level `let`/`var`, hooks (`beforeAll`/`afterAll`/`beforeEach`/`afterEach`), `vi.mock`/`vi.hoisted`, or parent-process `process.env` assignments occur in this file. `remoteShell` reads an environment variable once at import (`tunnel.test.ts:32`); the only mutable process-handle field is scoped per `makeRunningProcess` invocation (`tunnel.test.ts:64-88`).
- `testHttpClient`, `hangingHttpClient`, `testNetService`, and `encoder` are module-level immutable service/value instances (`tunnel.test.ts:90-123`). `testNetService` returns synthetic port 41773 (`:100`), also asserted at `:622` and `:883`; there is no `listen(41773)` in this file. SSH target port 2222 is fixture input (`:119`), and port 4773 is a wrong-command string (`:3110`), neither a local listener. Real fixture listeners request port `0` (`:1258`, `:1925`, `:3410`), or use dynamically reserved fixture ports (`:1962`, `:3455`).
- The repeated state key `711bc738002d72fd` (`tunnel.test.ts:196-198`, `:1860`) and `.test`/`.goat` paths are under per-test scoped temp homes (`:128`, `:1994`, `:2842`, `:3086`, `:3486`). `process.kill` is used for PIDs returned by those fixtures, notably the fixture cleanup at `:3519` and assertions at `:3880`. Sharing a fixture home across new files would invalidate that isolation.
- Generated child scripts read or set their own `HOME`/`T3_TEST_SEED` (`tunnel.test.ts:1896`, `:3384`, `:3461`); moving these strings must preserve their bytes. `nativeScripts` resolves `./tunnel.ts` relative to its own module (`:190-223`), so support files must stay in `src/` or adjust that URL. Retained-runner byte assertions at `:249-300` make a string rewrite risky.
- `setupFiles` loads `longTempDir.ts` (`vite.config.ts:69-73`), which mutates `TEMP`/`TMP` only on Windows (`packages/shared/src/testing/longTempDir.ts:8-17`). This runs per isolated test worker; it is separate from this test module's state. Parallel subprocess and temp-file load remain a CI performance uncertainty, despite no identified shared fixed port or directory.

## D. Runner and static config

- Package command is `vp test run --config ../../vite.config.ts --dir .` (`packages/ssh/package.json:27-30`). The root `test` config specifies Node, exclusions, 60s timeouts, and setup file (`vite.config.ts:62-74`), with **no explicit pool, isolation, maxWorkers, fileParallelism, include, or projects** there. This is one root config, with no SSH-specific project override in the inspected files. The tests import `./tunnel.ts` (`tunnel.test.ts:26`); its relevant script builders and manager are exported at `tunnel.ts:1387-1588`, `:1724`, and `:3053`, so the proposed support modules remain test-only.
- Installed Vitest 5.0.1 defaults to `isolate: true` and `**/*.{test,spec}.?(c|m)[jt]s?(x)` (`node_modules/.pnpm/vitest@5.0.1_*/node_modules/vitest/dist/config.cjs:15`, `:49-62`); resolution defaults to `pool: "threads"` and enabled file parallelism (`.../dist/chunks/index.DzobfTyw.js:14364-14366`, `:14507-14508`). With no override, run-mode workers default to `max(availableParallelism - 1, 1)` (`.../index.DzobfTyw.js:11777-11782`), but CI flags or `VITEST_MAX_WORKERS` can override (`:14518`). A `src/tunnel.<area>.test.ts` file matches the default include and the package `--dir .`.
- `packages/ssh/tsconfig.json:2-6` includes all `src`, so `src/tunnel.testSupport.ts` is typechecked. Test-only Effect diagnostic relaxation matches `**/*.test.ts`, **not** `*.testSupport.ts` (`tsconfig.base.json:55-59`); extraction may expose new diagnostics. `knip.jsonc:98-101` has the package wildcard and no SSH-specific ignore or helper entry; an imported support module is reachable, while unused exports may be flagged. Lint rules apply to ordinary `.ts` files (`vite.config.ts:110-127`, `:136-165`); the test-file override for raw RPC access matches `*.test.ts`, not `*.testSupport.ts` (`:212-219`). No relevant SSH-specific Oxlint override was found in the inspected config.
- Existing small tests use same-directory `./tunnel.ts` imports and local fixtures (`packages/ssh/src/tunnel.mcpSession.test.ts:13-28`, `packages/ssh/src/runtimeArchive.test.ts:1-24`). The split should preserve the existing `describe.skipIf(win32)` wrappers at `tunnel.test.ts:1857`, `:3050`, and `:3356`.

## E. Proposed split (10 test files)

These are **source test-body ranges**, not line ranges in the eventual files. Recreate the original `describe` wrappers and copy/move imports as required. Keep the shared top-level declarations `tunnel.test.ts:32-246` in an imported `src/tunnel.testSupport.ts`; move the runner-switch declarations `:1860-2176` to `src/tunnel.runnerSwitch.testSupport.ts`; move the protocol declarations `:3359-3765` to `src/tunnel.protocol.testSupport.ts`. Keep all three support modules in `src/` for relative `tunnel.ts` URLs. Test-support imports should expose only used symbols after typecheck/Knip.

| Target test file                      | Original test ranges           | Cases | Matched seconds | Helper set beyond imports                                                                                                                 |
| ------------------------------------- | ------------------------------ | ----: | --------------: | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `tunnel.core.test.ts`                 | 248-1855; 2178-2392; 2818-3354 |   116 |          94.661 | shared top-level helpers; runner-switch `shell`, `fixture`, version constants (`:1860-2176`)                                              |
| `tunnel.runner-switch.test.ts`        | 2394-2814                      |    29 |          88.061 | `shell`, `executable`, `fixture`, state/version constants (`:1860-2176`); shared helpers used by those tests                              |
| `tunnel.protocol-compat.test.ts`      | 3767-3970                      |    24 |         126.099 | `makeProtocolFixture`, `protocolExecutable` support (`:3359-3765`); `ARCHIVE`                                                             |
| `tunnel.protocol-legacy.test.ts`      | 3972-4127                      |    20 |         115.395 | protocol support; `ARCHIVE`                                                                                                               |
| `tunnel.protocol-refresh.test.ts`     | 4129-4241                      |    16 |          97.986 | protocol support; `ARCHIVE`, `testHttpClient`, `testNetService`, `uploadTarget`, `installArchivePsDouble`                                 |
| `tunnel.protocol-manager.test.ts`     | 4243-4368                      |     5 |         136.154 | protocol support; `ARCHIVE`, `testHttpClient`, `testNetService`, `uploadTarget`                                                           |
| `tunnel.protocol-replacement.test.ts` | 4370-4673                      |    37 |         133.796 | protocol support; `remoteShell`, `ARCHIVE`, `nativeScripts`                                                                               |
| `tunnel.protocol-acquisition.test.ts` | 4675-4886                      |    40 |         150.910 | protocol support; `remoteShell`, `ARCHIVE`, `nativeScripts`, `testHttpClient`, `testNetService`, `uploadTarget`, `platform`, `arch`       |
| `tunnel.protocol-stop.test.ts`        | 4887-5236                      |    15 |         157.113 | protocol support; `TEST_NODE_ENGINE_RANGE`, `testHttpClient`, `testNetService`, `uploadTarget`, `ARCHIVE`                                 |
| `tunnel.protocol-identity.test.ts`    | 5238-5465                      |    23 |         116.213 | protocol support; `remoteShell`, `TEST_NODE_ENGINE_RANGE`, `testHttpClient`, `testNetService`, `ARCHIVE`, `uploadTarget`, `nativeScripts` |

The 10-file plan sums to all 325 cases and 1216.388s of matched named durations. The largest measured lane is 157.113s; actual wall time cannot be predicted from these sums because omitted short cases, startup costs, CPU/I/O contention, and CI worker limits are unmeasured. The first two files are intentionally noncontiguous in the source to balance time; the split requires two additional fixture modules and careful preservation of generated script paths/bytes. No source or tests were changed in the checkout.
