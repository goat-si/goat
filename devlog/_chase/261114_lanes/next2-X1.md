# X1 CI (lane record)

Lane branch: `chase/t3-261114-next2-x1-ci`, head `530fabce64271dc1f27be020d420560e3d8b071f` (verified on origin; contains the integration head b531d2511c), cut from the integration branch `chase/t3-261114-next2` at `ed4268897e3183341694f27e488232572d5c5151` (draft PR #3660). Host pen-mac-studio. Plain push, no force. The nightly run 44049199276 signs on this host, so the lane stays light (logs, single test files) until the coordinator says its macOS jobs are done.

## Rows and commits

| row | GOAT commit | result |
| --- | --- | --- |
| goat#3646, probe (branch only, reverted before READY) | `83689f6caf476682820ca5e7831b718519f7a0ed` | `netns-probe` dispatch lane: one lidge `probe-netns` entry that checks a loopback-only network namespace |
| goat#3493 | `65e425704683d2b47668e41d69e8dd50667a6645` | every full run gets test-changed with every test file no suite owns; the two hand-written steps are gone; the step runs node --test after a Vitest failure |
| goat#3646, probe 2 (branch only, reverted before READY) | `a91b8064dc8c4fd7c59ea0aeb02c0812b9e8e593` | the probe's browser file inside bwrap |
| goat#3646, fix (approved 10:07:04) | `4c2873c6a0` | goat-test's Test step runs inside bwrap --unshare-user --unshare-net on self-hosted runners |
| goat#3646, the other two places (B2, test-server part replaced by option A) | `ae4304d961` | the wrapper moves into `.github/scripts/loopback-netns.sh`; goat-test, test-changed's Vitest run when its list has a web browser test or an apps/server test, and both test-server steps use it |
| goat#3646, proof lane (branch only) | `4f763a65ac` | the netns-probe lane runs test-changed with two browser files and test-server |
| merges of the integration head | `2f8a9d40e4` (bd3901fca9), `de982166fa` (b531d2511c) | git's own merges, no conflict, no CI file touched by CF1 |
| goat#3646, server tests back on the host (option A, 10:49:07) | `92bc15f067` | test-server unwrapped; test-changed wraps only web browser tests |
| goat#3646, conditions (2) and (3) | `530fabce64` | the rule moves into goat-ci-scope.cjs `wrapsChangedTests` (scope output `changed_tests_netns`), pinned by a scope test; loopback-netns.sh says in one line why server tests stay unwrapped |
| reverts of the four branch-only commits | `dc2ab0f891`, `c69e80fe25`, `dfab9857b6`, `757f01fe56` | revert 4f763a65ac, 6ff107eda7, a91b8064dc, 83689f6caf; no probe code remains (`rg 'netns-probe\|probe-netns'` finds nothing) |
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

> Coordinator to lane coordinator, 2026-11-17 10:07:04 UTC (quote each part verbatim in the lane's record and in next2-pr-plan.md under "Coordinator answers").
>
> B. X1, goat#3646:
> 1. THE WRAPPER IS APPROVED for goat-test's Test step as proposed at 4c2873c6a0 (self-hosted runners run the web tests inside bwrap with loopback only; no bwrap or a refusing profile fails the step before any test, never the host network; hosted runners unchanged). Evidence accepted: full run 44054114825 on lidge-goat-01, 984 of 984 files, 10,957 tests, 0 ERR_NETWORK_CHANGED lines.
> 2. YES, wrap the two other places with the same exposure, in the same commit series: the quick runs' test-changed step when it runs browser tests, and test-server's browser integration tests. Same rule: loud failure, never a silent fallback. One run each as proof (a quick pull request run that includes a browser test file; the server shard that holds the browser integration tests). Say for the server tests what they reach beyond loopback today (the preview browser tests start Chromium: do any need the network), before wrapping; if one does, bring it to me.
> 3. The two real hosts the web tests used to reach (Google's favicon service and cdn.agentclientprotocol.com): fine that nothing needs them; one line in the record naming the tests, and an issue only if a test's meaning depended on the live answer.
> 4. THE RUNNER HOST FINDING is accepted (the read-only thread on "linux": the eduroam Wi-Fi link wlp13s0 fails to reconnect and loses its IPv4 address for about a second; 14 times in the last 24 hours, exact matches to both failed runs; the wired link stays the default route; nothing changed on the host). X1 posts it on goat#3646 as one comment and quotes it in next2-X1.md. I am asking the owner whether to turn Wi-Fi off on that host; that is his to apply. The wrapper goes in regardless.
> 5. The nightly: run 44055174254 failed its Windows jobs again (a different gate, see G) and is cancelled, so the Mac Studio runner is idle NOW: X1 runs its check:changed and the timing of goat#3493's added files now, and must be back to light work when I announce the next nightly (I will say so). Then: the three branch-only probe commits reverted, READY.

> Coordinator to lane coordinator, 2026-11-17 10:49:07 UTC, for X1 (quote verbatim in its record and in next2-pr-plan.md under "Coordinator answers").
> goat#3646, B2: OPTION A. test-server stays on the host network; test-changed wraps only *.browser.test.* files; goat-test stays wrapped as approved. The three server files that fail inside bwrap fail for a right reason (root-or-self ownership checks see host root as uid 65534 in an unprivileged user namespace: BrowserDevToolsActivePort.test.ts, cua/linuxHelperHost/helperBundle.test.ts, hub/disposable/keyPath.test.ts): the checks and their expectations are not touched. This replaces my 10:07:04 item B.2 ("wrap the two other places"): test-server is NOT wrapped.
> Conditions: (1) the record names the server files that launch Chromium (ServerBrowserPage.test.ts and the rest of the about 78) as still exposed to a host network change, with goat#3646 as the place to revisit if a server shard ever shows ERR_NETWORK_CHANGED, and says that no server test needs the network (the proof run's zero counts); (2) the wrapper script states in one comment line why server tests are not wrapped (ownership checks under an unprivileged user namespace), so nobody "completes" it later; (3) the test-changed rule is pinned by a goat-ci-scope test: a selection holding a web *.browser.test.* file is wrapped, a selection holding only apps/server files is not; (4) goat#3646 stays open until the owner's Wi-Fi decision is applied or a week of goat-test runs shows no ERR_NETWORK_CHANGED; X1 says so in a comment there with the proof runs.
> Push 92bc15f067 and send READY; I start the review of the lane head (goat#3646's wrapper and goat#3493 together) when it is on origin. No further CI run is needed for A, as you say.

Lanes also merge the integration head before READY (the coordinator's 10:29:46 and 10:39:09 messages, as relayed): bd3901fca9 and b531d2511c are merged here, and check:changed runs against origin/chase/t3-261114-next2.

## goat#3646: option A and its conditions

- (1) Still exposed to a host network change: the about 78 server test files that launch Chromium or name Playwright, `apps/server/src/preview/ServerBrowserPage.test.ts` and the rest of `apps/server/src/preview/` (e.g. `ServerBrowserNavigate`, `scrollCollector`, `blockedDragFence`, `actionScrollRace`, `PdfDocumentNavigation`), plus `apps/server/src/mcp/SecretRequestCode|Login|Card.integration.test.ts`; they run in test-server and in test-changed lists without a web browser file, on the host network. goat#3646 is the place to revisit if a server shard ever shows ERR_NETWORK_CHANGED. No server test needs the network: run 44062651705's four shards inside bwrap had zero ERR_NETWORK_CHANGED, ENOTFOUND, EAI_AGAIN, ENETUNREACH and ERR_INTERNET_DISCONNECTED lines.
- (2) `.github/scripts/loopback-netns.sh`: "Server tests stay unwrapped: their root-or-self ownership checks see host root as another user here."
- (3) `goat-ci-scope.test.cjs` "runs test-changed with loopback only for web browser tests, never for server tests alone": a list with `keyPath.test.ts` and a web browser file is wrapped; `keyPath.test.ts` with `ServerBrowserPage.test.ts` is not; a scripts file alone is not. `main()` writes `changed_tests_netns=false` for a manual full run (its test-changed holds scripts, marketing and provider-testing files).
- (4) Comment on goat#3646 with the proof runs and the closing rule (open until the Wi-Fi decision is applied or a week of goat-test runs shows no ERR_NETWORK_CHANGED): https://github.com/goat-si/goat/issues/3646#issuecomment-6945949730.

Checks on the head (530fabce64): `node --test .github/scripts/goat-ci-scope.test.cjs` tests 73, pass 73, fail 0; `vp run check:changed origin/chase/t3-261114-next2`: `5 files since b531d2511c26`, `CHECK_EXIT=0`, format, lint, knip 1/2 and 2/2, agent surface audit, agent context budget, typecheck (42 packages), test (1 file), node --test (1 file) pass; pre-push workflow guard exit 0 on 92bc15f067 and on the final tree before push. Line counts: goat-ci-scope.cjs 991, goat-ci-scope.test.cjs 995 (cap 1000, no budget entry).

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

## goat#3646: the host (B4)

Posted on goat#3646 as one comment: https://github.com/goat-si/goat/issues/3646#issuecomment-6945075169. The finding as accepted, quoted from B4: "the read-only thread on "linux": the eduroam Wi-Fi link wlp13s0 fails to reconnect and loses its IPv4 address for about a second; 14 times in the last 24 hours, exact matches to both failed runs; the wired link stays the default route; nothing changed on the host". Turning Wi-Fi off is the owner's to apply.

## goat#3646: the hosts the web tests reached for real (B3)

Google's favicon service (URL built in `packages/shared/src/favicon.ts`; `ChatMarkdown.browser.test.tsx` "favicon privacy" asserts the URL string only; chat views that render links load it) and cdn.agentclientprotocol.com (registry icons rendered by `AcpRegistrySearchStep.browser.test.tsx`; the fetch and cache test `AcpRegistryIcon.test.ts` stubs `fetch`). No test's meaning depends on the live answer and all passed with the network gone, so no issue.

## goat#3646: test-changed and test-server (B2, commit ae4304d961)

What the server tests reach beyond loopback, read before wrapping: the 78 server test files that name Chromium or Playwright (mostly `apps/server/src/preview/`, plus three `mcp/SecretRequest*.integration` files) use reserved hosts (`login.test`, `page.test`, `*.example`, `example.com`) through route interception or fake pages; the others are `10.255.255.1` (`ServerBrowser.test.ts:629`, a message to a fake page), `frame.local` and `device.local` (request objects emitted on a fake page). None loads a real host. The rest of the server suite has no network guard and names real hosts mostly as fixture strings (github.com 404 times, provider API hosts), which static reading cannot prove unfetched; the proof run below decides it.

One script for every place, `.github/scripts/loopback-netns.sh`: a hosted runner runs the command as it is; a self-hosted one without bwrap prints `::error::bwrap is missing on <runner>` and exits 1; otherwise `exec bwrap --unshare-user --unshare-net --dev-bind / / --proc /proc "$@"`. test-changed wraps its Vitest run only when the list holds a `.browser.test.` file or an `apps/server/` test, so a full run's test-changed (scripts, marketing, provider-testing files) keeps the host network. Local check of the script with stubs: no bwrap gives the error and exit 1; a refusing bwrap exit 1; a working bwrap gets exactly those arguments; hosted runs vp. The test-changed condition under bash: a web browser file or a server file selects the wrapper, a packages/shared file does not.

Proof run (branch-only lane at 4f763a65ac): https://github.com/goat-si/goat/actions/runs/44062651705.

- goat-test-changed, job 133968995754, lidge-goat-01: CHANGED_TESTS `ReopenClosedViewShortcut.browser.test.tsx` and `apps/server/src/preview/ServerBrowserPage.test.ts` (launches real Chromium); `Test Files 2 passed (2)`, 8 and 49 tests; the only `net::ERR_` line is Vitest's `__vitest_interception_probe__` ERR_ABORTED. It was a dispatch of the test-changed step, not a pull request's quick run: AGENTS.md says "Never make a PR unless the developer explicitly asks you to do so".
- test-server inside bwrap (all four shards; the Chromium-launching files are spread over every shard by the weighted sequencer): 2/4 lidge-goat-04 `527 passed | 1 skipped (528)`; 4/4 lidge-goat-03 `525 passed | 3 skipped (528)`; 1/4 lidge-goat-01 (job 133968995580) `1 failed | 525 passed | 1 skipped`, 11 tests; 3/4 lidge-goat-05 (job 133968995858) `2 failed | 522 passed | 4 skipped`, 23 tests. No shard log has ERR_NETWORK_CHANGED, ENOTFOUND, EAI_AGAIN, ENETUNREACH or ERR_INTERNET_DISCONNECTED: no server test needs the network.
- The three failing files fail on ownership, not network: inside an unprivileged user namespace host root is unmapped and shows as uid 65534. `src/preview/BrowserDevToolsActivePort.test.ts` receives `untrusted_owner` (e.g. :231 expected `not_found`); `src/cua/linuxHelperHost/helperBundle.test.ts` receives "GOAT's Linux computer use helper was not started: /tmp belongs to another user" (:64); `src/hub/disposable/keyPath.test.ts` receives `{ directory: "/", owner: 65534, problem: "owner" }`. These are trust checks refusing correctly; bwrap cannot map host root without privilege, so the namespace cannot hold them. Brought to the coordinator with the options; he chose option A at 10:49:07 (below).

## goat#3493

- `scripts/lib/changed-tests.ts` exports `trackedTests(root)`, the listing the `providerEnv.ts` case already used (moved, not changed).
- `.github/scripts/goat-ci-scope.cjs` `withUnownedTests`: `planRun` gives every full result (lane all, ci:full, the affected or quick fallback to the full matrix) test-changed with `testsOutsideSuites(root, trackedTests(root))`. The quick run's fallback no longer computes its own subset.
- `.github/workflows/goat-ci.yml`: "Test build scripts" (13 files) and "Test CI scripts" (7 files) removed; "Test changed files" keeps going after a failure and exits with the last failure.
- What a full run now adds: 126 Vitest files (123 under scripts/, apps/marketing/src/accountDeletion.test.ts, apps/marketing/src/lib/userDocs.test.ts, packages/provider-testing/src/replayWorkspace.test.ts) and all 10 node files under .github/scripts, 5,052 bytes of the 100,000-byte list limit. Previously run there: 13 scripts files and 7 node files.

Verification (fresh, on 65e4257046's tree; rerun on the final tree as noted):

- `vp run check:changed origin/chase/t3-261114-next2` (the rule from the coordinator's 10:39:09 message) on de982166fa (before 92bc15f067 existed): `check:changed: 5 files since b531d2511c26`, `CHECK_EXIT=0`, all checks pass. `node --test .github/scripts/goat-ci-scope.test.cjs` on the reverted tree: tests 72, pass 72, fail 0.

- `vp run check:changed` at 2026-11-17 10:08Z (nightly cancelled, answer B5): `CHECK_EXIT=0`; format, lint, knip 1/2 and 2/2, agent surface audit, agent context budget, typecheck (42 packages), test (1 file), node --test (1 file) all pass; the lint warnings are all on comments that predate the change.
- Timing on pen-mac-studio: the 126 Vitest files `Test Files 125 passed | 1 skipped (126)`, `Tests 1350 passed | 12 skipped (1362)`, 72 s wall; the 10 node files `tests 224, pass 224, fail 0`, 38 s. The summary output does not name the skipped file (not checked). In dev's full run 44049203514 the two removed steps took 8 s and 31 s of goat-test, so goat-test gets about 39 s shorter and a full run gains one parallel lidge job, test-changed, of about two minutes of tests plus its setup; the test-server shards still set the run's wall time.

- Fail first: the new case "gives every full run, manual or ci:full, the test files no suite owns as test-changed (#3493)" failed before the fix at `assert.ok(result.tasks.includes("test-changed"))` (goat-ci-scope.test.cjs:524).
- `node --test .github/scripts/goat-ci-scope.test.cjs`: tests 72, pass 72, fail 0. No existing expectation changed (the quick fallback case at :662 passes unchanged).
- Step reproduction: the "Test changed files" script from HEAD^ and from the change, extracted from the YAML and run under `bash -e` with a stub `vp` whose `test run` fails: before `exit=1 node_ran=0`, after `exit=1 node_ran=1`. The Mac's bash 3.2 lacks `mapfile`, so only the two `mapfile` lines were replaced by an equivalent read loop in both copies.
- `vp fmt --check` and `vp lint` on the four files clean except three warnings that predate the change. Line count `goat-ci-scope.cjs` 993 with the probe commit, 984 without (cap 1000, unbudgeted).

NOT RUN: a full goat-ci run with the change.
NOT RUN: a CI run of the wrapper on a runner without bwrap or with a refusing profile (shown locally with stubs only).
NOT RUN: a CI run of the final head 530fabce64 (the coordinator: "No further CI run is needed for A"); option A only removes the wrapper from steps that pass unwrapped on dev, and the test-changed condition is pinned by the scope test.

## Review of 530fabce64 and the fix round (local)

> Coordinator to lane coordinator, 2026-11-17 10:57:56 UTC (quote each part verbatim in the lane's record, in card 10.027 and in next2-pr-plan.md under "Coordinator answers").
>
> B. X1 READY at 530fabce64 and N4 READY at 957cea501d: both checked on origin; both reviews are running (Opus 5.5 xhigh, read-only): goat-next2-X1-final-530fabce (the wrapper script's every path that could run tests outside the namespace, the workflow guard, the mixed selection of a web browser file and a server ownership test, goat#3493's coverage: no test file may end up run by nothing) and goat-next2-N4-final-957cea50 (C4: every deletion and rename with its lock and its crash state; O14's reversed protection; O17's links; O16's re-check and the agent path; goat#3664; the rule 3 lines). Both lanes stand by; no push until the verdicts. N4's Known limits line is accepted for #3660's body. N4's host note (isSshProvisionedRuntime.test.ts fails when SSH_CONNECTION is set in the shell): N4 files an issue if none exists (a test that reads the developer's environment), number to me.

> Coordinator to lane coordinator, 2026-11-17 11:00:49 UTC, for X1 (quote verbatim in its record).
> The mixed-selection defect at 530fabce64 (test-changed wrapped its whole Vitest run when the selection held any web browser file, so a server ownership test selected with it would fail inside the namespace): good that X1 found it itself, and the fix's shape is right (only the web browser files go inside the namespace; the other files run on the host). DECISION: do NOT push while the review runs. The review of 530fabce64 goes on (its brief asks about exactly this selection, so its verdict will name it or miss it, which tells me something either way). 8ae3f33912 becomes the FIRST commit of the fix round, together with whatever else the review finds, and a new reviewer reads the round with this report. Meanwhile X1 finishes its local checks on 8ae3f33912 (the full scope tests, check:changed against the integration head a6992a0f36, the workflow guard) and adds one more case to the step reproduction: a selection whose web browser file FAILS and whose host files pass, and the reverse: the step's exit status must be a failure in both, and both halves must have run. No CI run until the fix round is complete.

Self-found defect at 530fabce64: test-changed wrapped its whole Vitest run when the list held any web `*.browser.test.*` file, so a server ownership test selected beside it (e.g. `apps/server/src/hub/disposable/keyPath.test.ts`) would run inside the user namespace and fail; the scope test at 530fabce64 asserted the mixed list is wrapped.

Fix round, LOCAL ONLY (not pushed, per 10:57:56 and 11:00:49):

| commit | what |
| --- | --- |
| `8ae3f33912` | goat-ci-scope.cjs `loopbackTests` publishes only the web browser files as `changed_tests_netns` (a JSON list); the step runs the other files on the host and only those inside loopback-netns.sh; the scope test "runs only test-changed's web browser tests with loopback only, never a server test beside them" pins a mixed list (`[keyPath, web, scripts/dev-runner]` gives `[web]`) and a server-only list (gives `[]`) |
| `6ab397e58f` | merge of the integration head a6992a0f36 (S4), git's own merge, no CI file touched by S4 |

Checks (local, on 8ae3f33912 and 6ab397e58f):

- Test first: the new scope test failed on 530fabce64's code (`loopbackTests` missing; pass 0, fail 1), passes after.
- `node --test .github/scripts/goat-ci-scope.test.cjs` on 8ae3f33912: tests 73, pass 73, fail 0.
- `vp run check:changed origin/chase/t3-261114-next2` on 6ab397e58f: `5 files since a6992a0f365e`, `CHECK_EXIT=0`; format, lint, knip 1/2 and 2/2, agent surface audit, agent context budget, typecheck (42 packages), test (1 file), node --test (1 file) pass.
- Workflow guard on 6ab397e58f: exit 0.
- Step reproduction: the "Test changed files" script extracted from goat-ci.yml, run under /bin/bash -e with a `mapfile` shim (the Mac's bash 3.2 lacks it), stub `vp` (fails when its arguments match a chosen file) and stub `bwrap` (marks the run as inside), RUNNER_ENVIRONMENT=self-hosted, list `[keyPath.test.ts, ReopenClosedViewShortcut.browser.test.tsx, scripts/dev-runner.test.ts]`:
  - web browser file fails, host files pass: host half ran (netns=no, pass), web half ran (netns=yes, FAIL), step exit 1;
  - host files fail, web browser file passes: host half ran (netns=no, FAIL), web half ran (netns=yes, pass), step exit 1;
  - nothing fails: both halves ran, step exit 0;
  - server-only list: one host run (netns=no), no bwrap.

NOT RUN: any CI run of the fix round (11:00:49: none until the round is complete).

## Both-sides file at #3660's final dev merge

Coordinator, 2026-11-17 11:08:30 UTC, item 3 (as relayed): dev moved to 6f872e6b2d (#3662 9835304ca7, #3668 6f872e6b2d); no lane merges dev now.

- `.github/scripts/goat-ci-scope.cjs` changes on both sides. dev adds one `WINDOWS_SUITES` entry, `"scripts/build-desktop-artifact.selfcheck"` (after `"scripts/build-computer-use-helper"`, :75 at the merge base 3ecea04f19); X1's changes are elsewhere in the file (`withUnownedTests`, `loopbackTests`, the `changed_tests_netns` output, the `trackedTests` import). Keep both. `git merge-tree --write-tree HEAD origin/dev` on the local fix-round head 6ab397e58f against dev 6f872e6b2d: a clean tree (8b835dfd7b), no conflict. The merged file is 992 lines (cap 1000).
- dev changes no line of goat-ci.yml, goat-ci-scope.test.cjs or scripts/lib/changed-tests.ts.
- dev's new `scripts/build-desktop-artifact.selfcheck.test.ts` is a scripts test no suite owns, so after goat#3493 every full run's test-changed runs it with no list to edit; test-windows keeps running it through the new WINDOWS_SUITES entry.

Host: pen-mac-studio is LIGHT from 11:08:30 (nightly run 44071261820 signs there) until the coordinator says its macOS jobs are done.

