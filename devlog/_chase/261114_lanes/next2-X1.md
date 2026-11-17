# X1 CI (lane record)

Lane branch: `chase/t3-261114-next2-x1-ci`, head `65e425704683d2b47668e41d69e8dd50667a6645`, cut from the integration branch `chase/t3-261114-next2` at `ed4268897e3183341694f27e488232572d5c5151` (draft PR #3660). Host pen-mac-studio. Plain push, no force. The nightly run 44049199276 signs on this host, so the lane stays light (logs, single test files) until the coordinator says its macOS jobs are done.

## Rows and commits

| row | GOAT commit | result |
| --- | --- | --- |
| goat#3646, probe (branch only, reverted before READY) | `83689f6caf476682820ca5e7831b718519f7a0ed` | `netns-probe` dispatch lane: one lidge `probe-netns` entry that checks a loopback-only network namespace |
| goat#3493 | `65e425704683d2b47668e41d69e8dd50667a6645` | every full run gets test-changed with every test file no suite owns; the two hand-written steps are gone; the step runs node --test after a Vitest failure |
| goat#3646, fix | none yet | waits on the coordinator (second probe run or the wrapper proposal) and on item 2 (host) |

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

Item 2 (the lidge host thread) is the coordinator's, per the lane coordinator's relay.

## goat#3646: the probe (item 3)

The pre-push guard allows only goat-ci's fixed job set, so the probe is a `ci` matrix task that only the branch's `netns-probe` dispatch lane selects (commit `83689f6caf`; guard exit 0 on it). One run: https://github.com/goat-si/goat/actions/runs/44051654894, job 133931369505, lidge-goat-02, 09:03Z.

- `unshare --user --net` fails: `unshare: write failed /proc/self/uid_map: Operation not permitted`. Host: Ubuntu 26.04.1, kernel 7.0.0-43, util-linux 2.41.3, `kernel.apparmor_restrict_unprivileged_userns=1`, `kernel.apparmor_restrict_unprivileged_unconfined=1`, runner process `unconfined`, uid 997 ghr-goat.
- `bwrap --unshare-user --unshare-net --dev-bind / / --proc /proc` (bubblewrap 0.11.1) works: exit 0, `lo 127.0.0.1/8 ::1/128`.
- `ReopenClosedViewShortcut.browser.test.tsx` passed on the host network (8 tests, 5.27 s). Inside a namespace it was tried only through unshare, so Vite and Chromium inside bwrap are not yet shown. Asked the coordinator (needs_input, 2026-11-17) for one more probe run with the file inside bwrap.
- For item 2: the runners run on the host itself (`systemd-detect-virt: none`); interfaces are lo, enp6s0 (wired, UP), wlp13s0 (Wi-Fi, UP), tailscale0.

## goat#3493

- `scripts/lib/changed-tests.ts` exports `trackedTests(root)`, the listing the `providerEnv.ts` case already used (moved, not changed).
- `.github/scripts/goat-ci-scope.cjs` `withUnownedTests`: `planRun` gives every full result (lane all, ci:full, the affected or quick fallback to the full matrix) test-changed with `testsOutsideSuites(root, trackedTests(root))`. The quick run's fallback no longer computes its own subset.
- `.github/workflows/goat-ci.yml`: "Test build scripts" (13 files) and "Test CI scripts" (7 files) removed; "Test changed files" keeps going after a failure and exits with the last failure.
- What a full run now adds: 126 Vitest files (123 under scripts/, apps/marketing/src/accountDeletion.test.ts, apps/marketing/src/lib/userDocs.test.ts, packages/provider-testing/src/replayWorkspace.test.ts) and all 10 node files under .github/scripts, 5,052 bytes of the 100,000-byte list limit. Previously run there: 13 scripts files and 7 node files.

Verification (fresh, on 65e4257046's tree):

- Fail first: the new case "gives every full run, manual or ci:full, the test files no suite owns as test-changed (#3493)" failed before the fix at `assert.ok(result.tasks.includes("test-changed"))` (goat-ci-scope.test.cjs:524).
- `node --test .github/scripts/goat-ci-scope.test.cjs`: tests 72, pass 72, fail 0. No existing expectation changed (the case "runs the full suite when the selected tests outgrow what test-changed takes, and keeps the ones no suite owns" passes unchanged).
- Step reproduction: the "Test changed files" script from HEAD^ and from the change, extracted from the YAML and run under `bash -e` with a stub `vp` whose `test run` fails: before `exit=1 node_ran=0`, after `exit=1 node_ran=1`. The Mac's bash 3.2 lacks `mapfile`, so only the two `mapfile` lines were replaced by an equivalent read loop in both copies.
- `vp fmt --check` and `vp lint` on the four files clean except three warnings that predate the change. Line count `goat-ci-scope.cjs` 993 with the probe commit, 984 without (cap 1000, unbudgeted).

NOT RUN: `vp run check:changed` (host constraint: the nightly's Desktop macOS arm64 job still running).
NOT RUN: the time the 126 Vitest and 10 node files add (needs a scripts-wide run; same constraint, and the real figure comes from a lidge runner).
NOT RUN: a full goat-ci run with the change.
