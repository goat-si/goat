# X1 CI (lane record)

Lane branch: `chase/t3-261114-next2-x1-ci`, head `6ff107eda7ff79eac9147b550a736ae0f472e3a2`, cut from the integration branch `chase/t3-261114-next2` at `ed4268897e3183341694f27e488232572d5c5151` (draft PR #3660). Host pen-mac-studio. Plain push, no force. The nightly run 44049199276 signs on this host, so the lane stays light (logs, single test files) until the coordinator says its macOS jobs are done.

## Rows and commits

| row | GOAT commit | result |
| --- | --- | --- |
| goat#3646, probe (branch only, reverted before READY) | `83689f6caf476682820ca5e7831b718519f7a0ed` | `netns-probe` dispatch lane: one lidge `probe-netns` entry that checks a loopback-only network namespace |
| goat#3493 | `65e425704683d2b47668e41d69e8dd50667a6645` | every full run gets test-changed with every test file no suite owns; the two hand-written steps are gone; the step runs node --test after a Vitest failure |
| goat#3646, probe 2 (branch only, reverted before READY) | `a91b8064dc8c4fd7c59ea0aeb02c0812b9e8e593` | the probe's browser file inside bwrap |
| goat#3646, fix (proposed) | `4c2873c6a0` | goat-test's Test step runs inside bwrap --unshare-user --unshare-net on self-hosted runners |
| goat#3646, run lane (branch only, reverted before READY) | `6ff107eda7ff79eac9147b550a736ae0f472e3a2` | the netns-probe lane runs goat-test alone, for the one full run |

## goat#3646: the cause

Posted as one comment, no retitle: https://github.com/goat-si/goat/issues/3646#issuecomment-6943444770

The Vite dev server is answering normally when the fetch fails. Chromium fails every request it has pending with `net::ERR_NETWORK_CHANGED` when the shared runner host reports a network change, so the failing module is whichever was in flight.

| run / job | runner | ERR_NETWORK_CHANGED | window | failure |
| --- | --- | --- | --- | --- |
| 44024558196 / 133847141204 | lidge-goat-03 | 869 lines | 06:04:16.840Z to 06:04:17.480Z | 7 files fail to import, listed in the summary at 06:04:29Z; 976 passed |
| 44031306042 / 133868799856 | lidge-goat-02 | 291 lines | 07:05:11.838Z to 07:05:11.881Z | factory for `client-runtime/src/connection/driver.ts` fails on `deps/effect_Layer.js` at 07:05:11.879Z |
| 44018308235 / 133823059413 | lidge-goat-05 | none logged | n/a | factory for `src/state/entities.ts` at 05:07:07.864Z; step exits within a second, log may not have flushed; fits, unproven |

No log has an "optimized dependencies changed", reload, restart or out-of-memory line; the pre-bundle directory `ef98362b...` is the same in all three. The `/@vite/client` and `/src/bootstrap.ts` `ERR_FAILED` pair is a red herring: it comes at the same place in every run, after `ChatView.browser.test.tsx` and `GuestPage.browser.test.tsx`. Chromium has no switch to ignore address changes (`ignore_ip_address_changes` is an internal field; `--disable-new-network-change-notifier` is ChromeOS only).

## Coordinator answers (verbatim)

> Coordinator to lane coordinator, 2026-11-17 08:57:12 UTC, for X1 (quote verbatim in next2-pr-plan.md under "Coordinator answers" and in X1's record).
> goat#3646: the cause is accepted as found (Chromium fails every pending request with ERR_NETWORK_CHANGED when the shared runner host reports a network change; 869 lines in 0.64 s on lidge-goat-03 and 291 lines in 0.04 s on lidge-goat-02, the failing module inside that window; the third run fits but is unproven). DECISION: BOTH, in this order.
> 1. NOW, X1 posts the finding on goat#3646 as one comment (the three runs with their timestamps and counts, the red herring, what is still unknown, the two options) and retitles nothing.
> 2. OPTION 1, read-only first: name what changed the host's network at 2026-11-17 06:04:16Z and 07:05:11Z. If the lidge host is reachable from GOAT (host.status or ssh.host_list shows it; it carried a lane earlier in this plan), start ONE small read-only thread there: journalctl around those two seconds for NetworkManager, systemd-networkd, tailscaled, dockerd and the kernel (link up/down, address added or removed, veth and bridge events, IPv6 temporary addresses), plus ip -br addr and the list of interfaces that come and go with runner jobs (docker networks created per job are my first suspect: every job that starts a service container adds a bridge and veth pairs). It changes NOTHING on the host: no service restart, no sysctl, no config edit. It reports the event and the smallest host change that would stop it (for example IPv6 temporary addresses off, or the runners' service containers on one long-lived network). A change to the host is the owner's to approve: it comes to me as a proposal. If the host is not reachable from GOAT, say so and I ask the owner.
> 3. OPTION 2, the probe: X1 adds, on its branch only, a probe job that runs on the lidge runners and reports whether unshare --user --net (or bwrap --unshare-net) works there under the runner's user and AppArmor profile, and whether Vite and Playwright's Chromium start inside it with loopback up. ONE CI run on the branch (workflow_dispatch of goat-ci on chase/t3-261114-next2-x1-ci, or the pull request's own run if the job can be scoped to it); no change to the real goat-test job yet. If the probe passes, X1 proposes the wrapper for the browser test step with its diff and one full goat-test run inside it; the pre-push workflow guard and the "no retry, no timeout" rule both hold. If the probe fails, option 1 is the fix and goat-test keeps its rerun rule until then.
> 4. goat#3493 next, light, as you told it. The nightly's macOS jobs are still running: no builds on pen-mac-studio until I say they are done.

> Coordinator to lane coordinator, 2026-11-17 09:12:32 UTC (verbatim).
> 2. X1, the probe: YES to ONE more netns-probe run whose only change is running the same browser file inside "bwrap --unshare-user --unshare-net --dev-bind / / --proc /proc" on one lidge runner. In that run also print, from inside the namespace, ip -br addr (loopback only) and the Chromium log lines matching net::ERR_ (none expected). If it passes, propose the wrapper for goat-test's Test step as a diff plus ONE full goat-test run inside it, and answer in the proposal: what the browser tests can no longer reach and whether any test needs it (the tests that fail outside URLs on purpose must fail the same way); what happens on a runner without bwrap or where the profile refuses (the step must fail loudly, never fall back to the host network silently); and whether the epyc runners and the hosted runners need the same wrapper or a guard by runner label. If it fails, option 1 stands and waits for the lidge thread's report.
> 3. X1 goat#3493 (65e4257046), N4 O8 (3c1a80335d) and CF1's local commits: noted; their READYs come at the lane heads. X1's check:changed waits for the nightly's Desktop macOS arm64 job, as you said.

> Coordinator to lane coordinator, 2026-11-17 09:22:05 UTC (quote verbatim in next2-pr-plan.md under "Coordinator answers" and in each lane's record).
> 4. THE RUNNER HOST: understood: lidge, lidge-ts are lidge-AI-AI (a GPU box, no runners), lidge-cf times out, intmb refuses. I am asking the owner which machine carries the lidge-goat-0x runners and how to reach it. Nothing more to do on option 1 until he answers; the read-only thread is finished (it changed nothing: noted). Option 2 goes on: X1's wrapper diff and one full goat-test run inside it.
> 5. X1's second probe (run 44053573362, lidge-goat-04: loopback only inside bwrap, the browser file 8 of 8, no network error line beyond Vitest's own probe): accepted as passed.

Item 2 (the lidge host thread) is the coordinator's, per the lane coordinator's relay.

## goat#3646: the probe (item 3)

The pre-push guard allows only goat-ci's fixed job set, so the probe is a `ci` matrix task that only the branch's `netns-probe` dispatch lane selects (commit `83689f6caf`; guard exit 0 on it). One run: https://github.com/goat-si/goat/actions/runs/44051654894, job 133931369505, lidge-goat-02, 09:03Z.

- `unshare --user --net` fails: `unshare: write failed /proc/self/uid_map: Operation not permitted`. Host: Ubuntu 26.04.1, kernel 7.0.0-43, util-linux 2.41.3, `kernel.apparmor_restrict_unprivileged_userns=1`, `kernel.apparmor_restrict_unprivileged_unconfined=1`, runner process `unconfined`, uid 997 ghr-goat.
- `bwrap --unshare-user --unshare-net --dev-bind / / --proc /proc` (bubblewrap 0.11.1) works: exit 0, `lo 127.0.0.1/8 ::1/128`.
- `ReopenClosedViewShortcut.browser.test.tsx` passed on the host network (8 tests, 5.27 s). Inside a namespace it was tried only through unshare, so Vite and Chromium inside bwrap are not yet shown. Asked the coordinator (needs_input, 2026-11-17) for one more probe run with the file inside bwrap.
- For item 2: the runners run on the host itself (`systemd-detect-virt: none`); interfaces are lo, enp6s0 (wired, UP), wlp13s0 (Wi-Fi, UP), tailscale0.

- Probe 2 (accepted as passed, answer 5): https://github.com/goat-si/goat/actions/runs/44053573362, job 133937772989, lidge-goat-04. Inside bwrap as uid 997: `ip -br link` only lo, `ip -br addr` `lo 127.0.0.1/8 ::1/128`; the browser file 1 of 1, 8 tests, 3.00 s; the only `net::ERR_` line inside is Vitest's own `__vitest_interception_probe__ ERR_ABORTED`, which the host-network run has too.

## goat#3646: the wrapper (proposed, commit 4c2873c6a0)

On a self-hosted runner the Test step runs `exec bwrap --unshare-user --unshare-net --dev-bind / / --proc /proc vp run --filter @goat/web test`; a self-hosted runner without bwrap prints `::error::bwrap is missing on <runner>` and exits 1; a hosted runner runs `vp run --filter @goat/web test` as before.

One full goat-test run inside it: https://github.com/goat-si/goat/actions/runs/44054114825, job 133939573277, lidge-goat-01, 09:18:57Z to 09:26:20Z, success. The log shows the step's `exec bwrap ...` line; `Test Files 984 passed (984)`, `Tests 10957 passed (10957)`, 406.43 s; 0 `ERR_NETWORK_CHANGED` lines (869 in the failing host-network run 44024558196).

What the browser tests can no longer reach: anything beyond loopback. Requests outside loopback in the wrapped run, against the host-network run 44024558196:

| host | host network | in the namespace |
| --- | --- | --- |
| environment.test, assets.test, preview.test | ERR_NAME_NOT_RESOLVED or ERR_ABORTED | ERR_INTERNET_DISCONNECTED or ERR_ABORTED |
| example.com | ERR_ABORTED, once ERR_BLOCKED_BY_ORB (the host fetched it) | ERR_INTERNET_DISCONNECTED or ERR_ABORTED |
| 100.65.180.100:1 | ERR_UNSAFE_PORT (7) | ERR_UNSAFE_PORT (7) |
| 100.65.180.100:5173 | ERR_ABORTED | ERR_INTERNET_DISCONNECTED |
| 127.0.0.1:41234 | ERR_CONNECTION_REFUSED | ERR_CONNECTION_REFUSED |
| www.google.com/s2/favicons | loaded (no error line) | ERR_INTERNET_DISCONNECTED (3) |
| cdn.agentclientprotocol.com | loaded except one ERR_ABORTED | ERR_INTERNET_DISCONNECTED (9) |

The tests that fail outside URLs on purpose still see a failed load; only Chromium's error code changes. Two hosts the tests reached for real on the host network (Google's favicon service, the ACP registry CDN) now fail; every test still passes, so none needs them, and the step no longer depends on the internet. Loopback errors are unchanged apart from the burst: 4 ERR_FAILED (the `/@vite/client` red herring) in both runs.

A runner without bwrap, or a profile that refuses it: the step fails before any test runs and never runs on the host network. Local run of the step's script extracted from the YAML: self-hosted without bwrap `::error::bwrap is missing on lidge-goat-test`, exit 1; self-hosted with a bwrap that refuses (`bwrap: setting up uid map: Permission denied`), exit 1 through `exec`; neither ran vp. Hosted: vp ran, exit 0.

EPYC and hosted runners: goat-ci's `ci` job can only be the lidge pool or a hosted image (`.vite-hooks/goat-workflow-guard.mjs` pins it); the `epyc` labels are allowed only for the release workflows (guard :59, :494), and goat-ci.yml calls that host retired, so goat-test never runs there. Hosted ubuntu-24.04 runners are one VM per job with no neighbour jobs, show no ERR_NETWORK_CHANGED in the evidence, and do not ship bwrap, so the guard is by `RUNNER_ENVIRONMENT` (self-hosted wraps, hosted does not); any future self-hosted pool, EPYC included, gets the wrapper or fails loudly.

Shared exposure, not in this diff: quick runs' test-changed and test-server's browser integration tests run Chromium on the same host.

## goat#3493

- `scripts/lib/changed-tests.ts` exports `trackedTests(root)`, the listing the `providerEnv.ts` case already used (moved, not changed).
- `.github/scripts/goat-ci-scope.cjs` `withUnownedTests`: `planRun` gives every full result (lane all, ci:full, the affected or quick fallback to the full matrix) test-changed with `testsOutsideSuites(root, trackedTests(root))`. The quick run's fallback no longer computes its own subset.
- `.github/workflows/goat-ci.yml`: "Test build scripts" (13 files) and "Test CI scripts" (7 files) removed; "Test changed files" keeps going after a failure and exits with the last failure.
- What a full run now adds: 126 Vitest files (123 under scripts/, apps/marketing/src/accountDeletion.test.ts, apps/marketing/src/lib/userDocs.test.ts, packages/provider-testing/src/replayWorkspace.test.ts) and all 10 node files under .github/scripts, 5,052 bytes of the 100,000-byte list limit. Previously run there: 13 scripts files and 7 node files.

Verification (fresh, on 65e4257046's tree):

- Fail first: the new case "gives every full run, manual or ci:full, the test files no suite owns as test-changed (#3493)" failed before the fix at `assert.ok(result.tasks.includes("test-changed"))` (goat-ci-scope.test.cjs:524).
- `node --test .github/scripts/goat-ci-scope.test.cjs`: tests 72, pass 72, fail 0. No existing expectation changed (the quick fallback case at :662 passes unchanged).
- Step reproduction: the "Test changed files" script from HEAD^ and from the change, extracted from the YAML and run under `bash -e` with a stub `vp` whose `test run` fails: before `exit=1 node_ran=0`, after `exit=1 node_ran=1`. The Mac's bash 3.2 lacks `mapfile`, so only the two `mapfile` lines were replaced by an equivalent read loop in both copies.
- `vp fmt --check` and `vp lint` on the four files clean except three warnings that predate the change. Line count `goat-ci-scope.cjs` 993 with the probe commit, 984 without (cap 1000, unbudgeted).

NOT RUN: `vp run check:changed` (host constraint: waits for the coordinator to say the nightly's macOS jobs are done; Desktop macOS x64 was still running at 09:17Z).
NOT RUN: the time the 126 Vitest and 10 node files add (needs a scripts-wide run; same constraint, and the real figure comes from a lidge runner).
NOT RUN: a full goat-ci run with the change.
NOT RUN: a CI run of the wrapper on a runner without bwrap or with a refusing profile (shown locally with stubs only).
