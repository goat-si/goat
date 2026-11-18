# Next3 K8 — SSH and desktop shell

Cut at `f82d2df4b0960eb39bd36e4100b72b6f2758c7d2`. Checked row ancestry, commit trailers/titles, and current behavior. The provisioned worktree initially had the integration branch checked out. Created the assigned lane branch at the same commit.

## Compatibility and prior art, recorded before implementation

- `a48d7c6cd0` (C4 trust guidance). Upstream's normal OpenSSH failure path asks the operator to verify the fingerprint before reconnecting. GOAT's managed host path already points to fingerprint review via its trust flow, so keep that route and add guidance at the unmanaged SSH failure boundary. Old and new peers exchange the same SSH messages. Unknown or changed keys must still fail and the app must never authorize either.
- `22910ffdd2`. Upstream retains the input port in the attachment reply because `ssh -G` evaluates the alias's current config on each connection. GOAT keeps the resolved port for preparing and keying the connection and returns the caller's override at the save boundary. Existing persisted overrides remain explicit.
- `058d953646`. Upstream invokes recognized account shells in login mode before executing the same POSIX bootstrap on stdin. GOAT must preserve its remote watchdog and Git Bash route, along with the bootstrap state key and output framing.
- `79daf43c1c` (C4 cross-version runtime handoff). Upstream publishes a bounded marker before desktop quits and retries SSH adoption after detecting it. GOAT separately owns the app-server probe and its managed runtime. Older launchers ignore the marker. New clients must keep working with older desktop and CLI versions when it is absent. Cover expired, malformed, and missing markers and keep GOAT's independent-runtime policy.
- `e93f6ea361` (C4 IPC and command vocabulary). Upstream scopes Electron find results to the active tab and forwards a guest shortcut to the renderer. GOAT should retain its page ownership checks and use existing UI primitives. Older shells without the optional bridge render the existing controls, while an older web client can ignore the added IPC events. Cover missing bridge and hidden or mismatched tabs.
- `ff1eead6f4`. Upstream sends native browser zoom chords through the same app shortcut route used by the renderer. GOAT must give the preview route one chance to handle the event and avoid page zoom outside that route.
- `67fdc53823` (C4 IPC). Upstream identifies a same-data-home service by reading the local environment identity file. GOAT should use the same identity test without treating a remote route as authenticated for local actions. New renderer with older shell must tolerate missing optional IPC, and older renderer ignores the new method. Cover absent identity and unrelated environments.
- `a11ad7424d` (C4 asset and launch boundary). Upstream adds a path-tagged app-icon request behind filesystem-read authorization, while tool-origin app refs keep their existing scope. Keep launch a deliberate user action and preserve GOAT asset path checks. New clients fall back to generic icons when older servers reject the new variant. Old clients continue using existing asset variants on new servers. Cover insufficient scope, missing paths and wrong file type.
- `52d621a6f1`. Upstream uses the authenticated local identity from its theme prerequisite when deciding if Open in can act on the local host. GOAT should continue routing all other paths to the owning environment, even when a remote host also serves the desktop UI.
- `587deab7d3` (C4 settings). Upstream ties a single platform inhibitor to active agent runs, releasing it at idle or when disabled. GOAT uses its own settings access classifier and orchestration state. Older persisted settings must decode with a default and older clients must decode newer responses. A new control must handle older server behavior without confirming a setting the server did not accept. Cover idle, disabled, unsupported and shutdown.

`79daf43c1c` product decision. Stable and nightly GOAT desktop default to dedicated homes, while managed SSH launches use `$HOME/.goat` and the optional desktop attachment only probes a running app. A collision can still occur if a person explicitly configures desktop to use the managed SSH home. Decide whether to coordinate that opt-in shared home or require distinct homes. Recommend coordinating only explicitly shared homes with a per-home, expiring handoff marker and the existing SSH adoption path. This adds an on-disk marker and a bounded reconnect wait, with no new RPC, database rows or change for packaged default homes. Sources are `DesktopStatePaths.ts`, `desktopAppServer.ts`, `tunnel.ts` and upstream `79daf43c1c`.

## Row verdicts

| Upstream | Verdict | Lane commit | Behavior |
|---|---|---|---|
| `a48d7c6cd0` | Adapted | e2970138a1 | adds unmanaged host-key guidance while preserving the managed fingerprint flow |
| `22910ffdd2` | Adapted | a02d547830 | keeps explicit SSH port overrides and leaves config-derived ports unset in saved targets |
| `058d953646` | Adapted | 7fe6f3cfcc | loads supported account login profiles before the same POSIX script and retains the watchdog |
| `79daf43c1c` | Decision | — | explicit shared-home update arbitration |
| `e93f6ea361` | Adapted | 88d31ac4a7, 0e1bba0d08 | desktop page Find, browser menu and command palette |
| `ff1eead6f4` | Adapted | 1297e757ca | the guest forwards unhandled Zoom in, out and reset chords |
| `67fdc53823` | Adapted | 9eaec74575 | loads themes and defaults from a connected same-home service when no primary is available |
| `a11ad7424d` | Adapted | 9be9e25e8c | filesystem-read grant for exact app-path icons and a deliberate local Open app action |
| `52d621a6f1` | Adapted | 965b6157b4 | routes Open in locally for a matching loopback service, including the file panel and favorite shortcut |
| `587deab7d3` | Adapted | c5202f780e | server-side inhibitor, scoped web/desktop and mobile controls, and an older-server capability gate |

**Review range.** Diff from `2c0e0002a996ec5d46c708919be5a43f579176fa` through the reported K8 head. All row commits are GOAT adaptations. Move-only commits `3dbac36e42`, `bee1e406d2`, `4de1a91e91`, `c0774cadff`, `3a6639dda5`, and `0792535d3b`. Post-merge fixture and type corrections `9931ecc96c`, `bab5269e1a`, `15b5ac2dfc`, and `88eaecd35b`.

## Conditional preview follow-up

[GOAT #3683](https://github.com/goat-si/goat/issues/3683) is in the preview path. The server-rendered viewer calls the authoritative Stop path. A desktop-rendered server tab still calls Electron Stop directly (`apps/web/src/components/preview/PreviewView.tsx:276` and `apps/server/src/preview/ServerBrowserStop.ts:43`). Decide whether a person can stop a load while an agent owns the tab or must take control first. Recommend the existing viewer control policy and an authenticated stop on the server tab's own CDP session. A request with a capability flag can retain the old desktop fallback for older servers. There are no persisted rows.

## Focused checks

On the final head, `vp test run` exited 0 with 674 passed and 14 platform skips across 33 whole files. From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run` exited 0 with 94 passed across 5 whole files, including every changed server test file.

| File | Passed | Skipped |
|---|---:|---:|
| `packages/ssh/src/command.diagnostics.test.ts` | 8 | 0 |
| `packages/ssh/src/remoteDeadline.test.ts` | 33 | 12 |
| `packages/ssh/src/runtimeFactsScripts.test.ts` | 20 | 0 |
| `packages/ssh/src/tunnel.core.test.ts` | 131 | 0 |
| `packages/ssh/src/tunnel.ensure-flight.test.ts` | 10 | 0 |
| `packages/ssh/src/tunnel.launch-identity.test.ts` | 6 | 2 |
| `packages/ssh/src/tunnel.managed-reuse.test.ts` | 2 | 0 |
| `packages/client-runtime/src/composerCapabilityItems.test.ts` | 18 | 0 |
| `packages/client-runtime/src/state/assets.test.ts` | 27 | 0 |
| `apps/mobile/src/features/settings/SettingsServerControlsRouteScreen.test.tsx` | 11 | 0 |
| `apps/web/src/components/ChatMarkdown.browser.test.tsx` | 28 | 0 |
| `apps/web/src/components/CommandPalette.composition.browser.test.tsx` | 17 | 0 |
| `apps/web/src/components/ReopenClosedViewShortcut.browser.test.tsx` | 8 | 0 |
| `apps/web/src/components/fleet/FleetConsoleHosts.browser.test.tsx` | 1 | 0 |
| `apps/web/src/components/fleet/FleetConsoleHub.browser.test.tsx` | 1 | 0 |
| `apps/web/src/components/fleet/FleetConsoleQuota.browser.test.tsx` | 1 | 0 |
| `apps/web/src/components/files/BrowserDocumentFrame.shortcuts.browser.test.tsx` | 1 | 0 |
| `apps/web/src/components/files/FilePreviewPanel.surfaces.browser.test.tsx` | 5 | 0 |
| `apps/web/src/components/preview/PreviewView.browser.test.tsx` | 15 | 0 |
| `apps/web/src/keybindings.layout.test.ts` | 1 | 0 |
| `apps/web/src/remoteOpen.test.ts` | 21 | 0 |
| `apps/web/src/assets/assetUrls.test.ts` | 4 | 0 |
| `apps/web/src/hooks/useDefaultTheme.test.ts` | 2 | 0 |
| `apps/web/src/hooks/useEnvironmentTheme.test.ts` | 4 | 0 |
| `apps/web/src/components/ChatView.logic.test.ts` | 56 | 0 |
| `apps/web/src/state/primaryEnvironment.test.ts` | 3 | 0 |
| `apps/web/src/components/settings/scopedSettings.test.ts` | 30 | 0 |
| `apps/web/src/components/settings/settingsSearch.test.ts` | 63 | 0 |
| `apps/desktop/src/preview/Manager.test.ts` | 54 | 0 |
| `apps/desktop/src/ipc/methods/localEnvironment.test.ts` | 1 | 0 |
| `apps/desktop/src/ipc/methods/preview.test.ts` | 5 | 0 |
| `packages/contracts/src/settings.test.ts` | 80 | 0 |
| `packages/contracts/src/agentSurface/settingsAccess.test.ts` | 7 | 0 |
| `apps/server/src/assets/NativeAppIconResolver.test.ts` | 1 | 0 |
| `apps/server/src/auth/RpcAuthorization.test.ts` | 47 | 0 |
| `apps/server/src/background/KeepAwake.test.ts` | 2 | 0 |
| `apps/server/src/environment/ServerEnvironment.test.ts` | 19 | 0 |
| `apps/server/src/process/externalLauncher.test.ts` | 25 | 0 |

Fail-first whole-file runs exited 1. Host key guidance had 2 expected failures, SSH alias port 1, account login 1, browser Find 1, guest zoom 1, shared-home theme 1, exact bundle icon 1, and shared-home Open in 1. The reports confirmed the expected behavior gap before each implementation.

## P1 and local exclusions

- Desktop browser Find from the page, browser menu and command palette. Check next/previous, Escape, and a page that owns the shortcut. Check zoom in, out and reset while the page has focus.
- Desktop launches with its primary disabled and a same-home service connected. Check its published/default theme, Chat and file-panel Open in, and a different-host route. On macOS, click an app bundle chip with a valid icon and a missing icon.
- In web/desktop and mobile Settings, flip the keep-awake switch for a supported server and check that an older server shows the disabled control. Capture the mobile setting. Observe idle sleep inhibitor acquisition during work, release at idle, and shutdown.
- NOT RUN: lane CI or PR, integrated dev servers, native devices and capture, live SSH to a real host, and manual sleep/wake on macOS, native Windows or Linux.

## Newer upstream intersections

Selected with `git log --oneline 93cbca3fcbd..8a6342e7613 -- <row paths>`. The SSH and power directory query also finds Include parsing and SSH release-base follow-ups. These rows stay for the next range.

### Later SSH and keep-awake rows

```text
8a6342e761 fix(server): keep-awake logs a hold only once acquired and reports why the inhibitor failed (#38505)
733821285c fix(ssh): read wildcard Includes in UTF-8 byte order (#38208)
100ba49a65 fix(ssh): Host patterns match Unicode aliases byte by byte like OpenSSH (#38184)
1379dd0bc6 fix(server): keep awake blocks Windows sleep when the server runs in WSL (#38072)
f390ae7f15 fix(ssh): an older client no longer replaces a newer running SSH server (#29428)
b50e98e71c fix(ssh): count bytes for Include question-mark wildcards (#37840)
ba1193273a fix(desktop): SSH environments download the remote runtime from T3CODE_RELEASE_BASE_URL (#31396)
12b9845d1c fix(ssh): verify runtime archives in homes containing newlines (#37150)
c8a1b5ff0b fix(ssh): preserve literal home paths in Include expansion (#33288)
d26375ed8a fix(ssh): include hosts from wildcard filenames with line separators (#35479)
0c306f4520 fix(ssh): wait for a boot service's server instead of starting a second one (#36672)
1ed6e32559 fix(ssh): ignore alias commands and TTY requests for T3 connections (#24570)
033bb5a82e fix(ssh): failed launches report only their own output (#35717)
```

All 117 original paths intersections, in upstream log order.

```text
8a6342e761 f5f8c8d18b 055b44919e 856c84e4b1 9b3b1c79a7 077b206b33 ecb295516f 0b3ebcf268
1379dd0bc6 10784e01f8 42a5aade84 cd9c39fe3c 48a64a8b68 5b91a5a00e d27002bf99 652e2f2ab5
86863beede 0597b9edcd 85dcfa61ca 20501a0221 428d365932 ebd007e6ae f390ae7f15 86a028cbd4
9e32c95576 e514c36f3c b4744496f8 e65a790ac5 6794d5646c fb89ce1680 ca432d7ed6 6e650b3849
7d32075e37 4247b5aa1a 6f5838f9bc 12b9845d1c 83f35dac5c 06150a08ec 109e9dbdfd 304cf149c8
6d3f6423a3 8897a6ebe1 7d9c365e17 5d589547f0 ca0ca71045 4fa5f0e0e6 40f63b468f 71adeef080
b1050d3449 4117bd42ec 16a70050f4 3947e22351 da95a04763 17db7082c0 355adf265c bf3549b7ad
81df733306 bdf6c6ec89 4dec8cf641 703810f308 01c8e59f14 2cc4b4888e 5f29d87c9b 304dc13648
ff17cd307f fa647599e0 b60abf32e0 5f80af6805 093c317858 34db335ed5 3a5d7f39a8 b5e4342a90
1ea5e4b42d 3c77d3d64b 6fc2fb192c eec0a37227 1f45f14ae8 dd5061364b b779d40077 45ff3f5967
0c6f421f3c f52e5c1919 db0ae7b6e1 cc0a7bb9d8 8a45c51d8b 0c306f4520 b37c959669 3b18dc2935
b4c1bd106d b2259d3c6c 86d49daf82 a760a3a965 ac180919a6 1ed6e32559 033bb5a82e 5ef603df34
9803d1adb5 31d9b3bcd6 a4723422e7 eea9d15ee2 580b526758 6bc105f04e fcf50ffe38 37714a8de5
db2cc20264 6fe782ca4a 913181c439 dea07a1b12 a37715c1e7 a2edd281df 42057b82d0 cf382b0c44
88d4d06ea3 2d80cb6bc7 3c1be119b9 36f011dfb7 48cdefed5a
```

## Gate recovery

The first completed `check:changed` on `88eaecd35bb804b966945337552bafb2beaa8a6e` exited 1. All static steps passed, including typecheck for 38 packages. Tests reported 12,171 passed, 2 failed and 18 skipped, plus three Fleet suites that failed to load. The Fleet fixtures mocked only the primary-environment atom, so the host/theme atoms moved to their own module. The HTML document bridge allowlist now includes the view-only browser Find action, which shares Cmd/Ctrl+F with the existing Find commands. The four previously failing web files and five adjacent files then passed 63/63.

The original Bash trace test failed in the same assertion on integration commit `2c0e0002a996ec5d46c708919be5a43f579176fa` (19 passed, 1 failed, exit 1). Bash's native `set -x` sends traces to stderr on this machine's Bash 3.2.57. The preexisting harness redirected a separate `BASH_XTRACEFD` and counted zero reads because that Bash ignored the override. Redirecting standard error captures the same trace without changing the assertions or the runtime script.

Web recovery `83f5a2fafd`. Bash fixture recovery `6c3f046c00`. The latter passed again as a whole file, 20/20. Earlier incomplete gate attempts exited 130 after type errors were identified.

The one integration merge was `a5d411e3f5da626938e8e0722c9487f8f0d1a2f3`, with second parent `2c0e0002a996ec5d46c708919be5a43f579176fa`. The lockfile had no merge delta. At the final gate's launch, the integration branch had advanced to `6def29ca359f546e50dcd731a6364e3f0d575545`. The merge base remained `2c0e0002a996` and an exact path comparison at launch found no overlap with the new integration commits.

## Final gate

`vp run check:changed origin/chase/t3-261114-next3` exited 0 on `6c3f046c0046dfbfe1b02f4befbf2ac30272dde3`. It compared 78 files with `2c0e0002a996ec5d46c708919be5a43f579176fa`. Format, lint, both Knip steps, GraphQL, agent-surface audit, agent context budget and typecheck for 38 packages passed. The test step finished with 627 files passed, 2 skipped, 12,157 tests passed, 18 skipped and zero failures. The naming check reported zero T3 residue. The dependency patch check was skipped because dependency files were stable.


**READY.** Pushed `chase/t3-261114-next3-k8` on a new branch and verified its remote head at `6c3f046c0046dfbfe1b02f4befbf2ac30272dde3`. The review diff is `2c0e0002a996ec5d46c708919be5a43f579176fa..6c3f046c0046dfbfe1b02f4befbf2ac30272dde3`.

## Fix round 1 compatibility and prior art

Reviewed head `6c3f046c0046dfbfe1b02f4befbf2ac30272dde3`.

- P2-1. Upstream `22910ffdd2` keeps the requested port in the SSH result because OpenSSH resolves aliases on each connection. GOAT must retain caller intent at the Connections, cloud and catalog boundaries before the SSH manager sees it.
- P2-2 and P2-3. Upstream `587deab7d3` bridges confirmed idle gaps with a grace interval. GOAT should stop the hold on uncertainty and disable, use the repository's bounded child shutdown pattern, and use the partial index in `RecoveryIndexes.ts` for its active snapshot.
- P2-4. Upstream `a11ad7424d` uses a specific absolute app path for icon resolution. GOAT should use that path for launch and verify it on the destination before opening it. Existing launches and reveals continue using the existing request shape.
- P3. Upstream `e93f6ea361` exposes Electron Find for tabs with the native find bridge. Share the rendering and bridge checks between the view, palette and keyboard path.
- `79daf43c1c` C4. Write an expiring marker only when a desktop uses the managed SSH home. Older launchers ignore the marker and have their existing race during the handoff. A newer launcher with an older desktop proceeds when the marker is absent. Ignore malformed, stale and foreign-home markers. Bound the wait, preserve live-runtime adoption, and clear failed/cancelled installs' markers. One file, no RPC or database changes.
- [GOAT #3683](https://github.com/goat-si/goat/issues/3683) C4. A server advertises native-tab Stop and applies its viewer-control policy before issuing CDP Stop and settling loading. Older clients keep their desktop IPC path. New clients use that path with older servers. Deny unauthorized or competing controllers and handle missing tabs without changing state. The capability and request are additive. There are no persisted rows.

## Fix round 1 delivery

| Item | Commit | Failing-first observation |
|---|---|---|
| P2-1 | `b6a947a76e` | Connections, Cloud Machines and catalog each passed a resolved port where the caller left it unset. Three failures. The browser tests exercise registration and the real SSH manager fixture checks forwarded argv ports 2222 and 2223 across reconnect from its savable target. |
| P2-2 | `dd7d4bc056` | Disable and failed activity reads retained the inhibitor, and the spawn options had no termination bound. Three failures. The production layer reaps a real helper that ignores TERM in the passing test. |
| P2-3 | `1bc4675bf1` | EXPLAIN QUERY PLAN showed a scan without the partial-index predicate. One failure. The final test checks the covering index seek and that disable drops the activity subscription. |
| P2-4 | `1a58d3c3b2` | Markdown launched a different same-name result than the literal icon path. The server accepted a missing bundle with a usable mock OS command. Both reproduced before the change. The existing error tag carries an optional bundle-validation reason. |
| P3 | `2d6a1d6ca0` | A bridge with only findInPage exposed Find in the palette. One failure. The palette, route shortcut and view share the capability and native-tab checks. |
| `79daf43c1c` | `66e02bbe48` | A shared-home desktop stopped without publishing a marker, and the remote probe did not wait on an active marker. Two failures. The POSIX fixtures check valid, expired, malformed and implausibly future timestamps. Existing native Windows ownership refusal still applies when the shared home contains a desktop-owned runtime. |
| #3683 | `481820d0db` | An advertised native Stop still called Electron instead of sending a request to the server. One failure. The server-side test covers CDP Stop, settling loading, refusal while another viewer has control and the missing tab. The older-capability browser case exercises Electron IPC. |

The keep-awake typecheck and subscription proof were completed in follow-up `902d8c6251`. No published commits were rewritten.

`git merge-tree --write-tree HEAD origin/chase/t3-261114-next3` exited 0 against `061fd0fee904c2abaada9efb5cfdb9ea58b18919`. The lane retains the previously merged integration parent `2c0e0002a996ec5d46c708919be5a43f579176fa`.

### Pre-merge focused checks

`vp test run …` from the repository root exited 0 with 182 passed across 11 files. `GOAT_TEST_TMP_GUARD=fail vp test run …` from `apps/server` exited 0 with 55 passed across five files, including every changed server test. Whole files ran with no test-name filtering.

NOT RUN: lane CI or PR, integrated real-client P1, native device capture, live shared-home desktop update and SSH adoption on a real peer, live Windows PowerShell runtime, OS sleep/wake, and live mixed-version desktop/server pairs.

### Gate recovery

The completed `check:changed` run on `902d8c6251541c62850ea7dd1e24b9fa1d5ca0b4` exited 1. All static checks passed. Its 750 selected files gave 13,292 passing tests, 18 skips and one failure. The launch-script byte invariant rejected the shared-home guard in the reusable generator's default output. The recovery keeps the default bytes and opts in only at owning SSH launch call sites. The original byte comparison is unchanged. The actual manager transport fixture also checks that its forwarded launch carries the guard.

Recovery commit `1acd6ed4bf` preserved the reusable script bytes and added a transport assertion for the guard. Its whole-file SSH command exited 0 with 169 passed. Counts were `tunnel.core.test.ts` 131, `tunnel.ensure-flight.test.ts` 10, and `runtimeProbe.invocations.test.ts` 28. A fresh integration conflict check exited 0 on the recovery head.

The first completed gate on `1acd6ed4bf9bf7ccb4f0036f97207d21c030e317` exited 1. All static checks and the unchanged byte invariant passed. The test stage reported 13,291 passed, 18 skipped and two failures across 750 files. `runnerProcess.test.ts` exceeded the graceful stop deadline and `FileBrowserPanel.browser.test.tsx` focused the wrong menu item. Both had passed in the preceding broad gate. Their whole-file rerun on this exact head exited 0 with 20 passed. The two failure paths have no direct changes in the recovery commit.


### Conflicting integration advance

The unchanged gate on `1acd6ed4bf9bf7ccb4f0036f97207d21c030e317` subsequently exited 0. All static steps and the test step passed with 13,293 passed, 18 skipped and 750 selected files.

The delivery conflict check against `9af811b8fc3d2fc0039efbafee606ca358d5a490` found conflicts in `externalLauncher.ts` and `MarkdownFileLink.tsx`. Merge `a4c6d466a96b45ca44747a012cf06c3b529128b1` keeps the incoming Windows ShellExecute path with the expanded target and keeps both the context-menu source and app-icon state. The merge did not change the lockfile.

Whole-file focused runs on the merge exited 0 with 318 passed across 12 files. From `apps/server`, two `GOAT_TEST_TMP_GUARD=fail vp test run …` batches exited 0 with 62 and 48 passed. Together they cover every changed server test and the existing server Stop suite.

The gate on `a4c6d466a96b45ca44747a012cf06c3b529128b1` exited 0. Its two batches gave 13,386 passed and 26 skipped across 756 files. The branch was pushed at that SHA. Post-push conflict detection found a further integration advance at `593f1a546485e78216218641731d15918bc1e34c` affecting desktop Manager imports and server browser controls. The authorized merge `1d5751624594866e8ad3daaf30ced0b559bbaad4` keeps U08's logical control registry and its renderer recovery, with K8's viewer-authorized loading Stop in `ServerBrowserNativeStop.ts`. Both sides' desktop Manager imports remain. The merge did not change the lockfile.

On the U08 merge, the whole-file focus command exited 0 with 451 passed and two platform skips in 20 files. From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run …` exited 0 with 110 passed in seven files, including all changed server tests.

| File | Passed | Skipped |
|---|---:|---:|
| `packages/ssh/src/command.diagnostics.test.ts` | 8 | 0 |
| `packages/ssh/src/runtimeFactsScripts.test.ts` | 20 | 0 |
| `packages/ssh/src/runtimeProbe.invocations.test.ts` | 28 | 0 |
| `packages/ssh/src/runtimeWindows.test.ts` | 17 | 0 |
| `packages/ssh/src/tunnel.core.test.ts` | 131 | 0 |
| `packages/ssh/src/tunnel.ensure-flight.test.ts` | 10 | 0 |
| `packages/ssh/src/tunnel.launch-identity.test.ts` | 6 | 2 |
| `packages/ssh/src/tunnel.managed-reuse.test.ts` | 2 | 0 |
| `packages/client-runtime/src/connection/catalogHost.test.ts` | 16 | 0 |
| `apps/web/src/remoteOpen.test.ts` | 21 | 0 |
| `apps/web/src/components/commandPaletteFindItems.test.tsx` | 1 | 0 |
| `apps/web/src/state/primaryEnvironment.test.ts` | 3 | 0 |
| `apps/web/src/components/ChatMarkdown.browser.test.tsx` | 34 | 0 |
| `apps/web/src/components/preview/PreviewView.browser.test.tsx` | 19 | 0 |
| `apps/web/src/components/settings/CloudMachinesSettings.browser.test.tsx` | 3 | 0 |
| `apps/web/src/components/settings/ConnectionEnvironmentsSection.browser.test.tsx` | 25 | 0 |
| `apps/desktop/src/preview/Manager.helpers.test.ts` | 6 | 0 |
| `apps/desktop/src/preview/Manager.test.ts` | 65 | 0 |
| `apps/desktop/src/updates/DesktopUpdates.sharedHome.test.ts` | 1 | 0 |
| `apps/desktop/src/updates/DesktopUpdates.test.ts` | 35 | 0 |
| `apps/server/src/assets/NativeAppIconResolver.test.ts` | 1 | 0 |
| `apps/server/src/background/KeepAwake.test.ts` | 7 | 0 |
| `apps/server/src/auth/RpcAuthorization.test.ts` | 47 | 0 |
| `apps/server/src/process/externalLauncher.test.ts` | 33 | 0 |
| `apps/server/src/preview/ServerBrowser.desktopSize.test.ts` | 4 | 0 |
| `apps/server/src/preview/ServerBrowser.stopLoading.test.ts` | 7 | 0 |
| `apps/server/src/preview/ServerBrowserStream.test.ts` | 11 | 0 |

The first gate on `1d5751624594866e8ad3daaf30ced0b559bbaad4` exited 1. Static checks and the 5,035-test server batch passed. The workspace batch had one failure in file-browser keyboard dismissal and 8,372 passes. The browser fallback's existing keyboard suite starts on the first enabled action, while the file-browser fixture expected the prior pointer action to have focus when the menu reopened. The fixture now parks the pointer and navigates to Copy mention before Escape. Its pointer-copy, focus and shadow-row restoration assertions are intact.

Fixture recovery `dd6456ad38` passed 23 tests in two whole browser files on the final candidate. `FileBrowserPanel.browser.test.tsx` passed 17 and `contextMenuFallback.keyboard.browser.test.ts` passed six. The current integration tip at the final gate launch was `a3255d1fd41b38f1d767a982e1c11b9361e1d842`. The conflict check against it exited 0, so the merge base remains `593f1a546485e78216218641731d15918bc1e34c`.


### READY receipt

`chase/t3-261114-next3-k8` was fast-forwarded and read back at `dd6456ad3878645fb385713c0acfde5b8e2906a8`. The gate used merge base `593f1a546485e78216218641731d15918bc1e34c` and a clean tracked worktree. `vp run check:changed origin/chase/t3-261114-next3` exited 0. Format, lint, both Knip stages, GraphQL, both agent checks and 38-package typecheck passed. The server batch passed 5,035 tests with 12 skipped. The workspace batch passed 8,373 tests with 14 skipped. Total 13,408 passed, 26 skipped and zero failures across 756 selected files.

NOT RUN: lane hosted CI, lane PR creation, P1 real-client and native capture, a real shared-home desktop update with SSH adoption, live native Windows PowerShell or OS sleep/wake, and live mixed-version pairs.

## Integration re-merge

Merged `d4dfd457571834bb2c3c85984e64f5abd4af0e5d`, which contains dev `a4392efb38b` (#3150), into `chase/t3-261114-next3-k8` at `4b4df3ba118c3f62c6f59845b842a7ea70c73fea`. The first parent is the prior lane head `dd6456ad3878645fb385713c0acfde5b8e2906a8`.

The sole content conflict was `packages/ssh/src/tunnel.ensure-flight.fixture.ts`. The fixture retains K8's mutable config port, recording of forwarded SSH ports, and owning-launch guard probe. It also retains #3150's app-server probe and request counters, refusal response, and pending-replacement fixture. Whole-file tests cover the alias reconnect and the Pen existing-only path. Removed the unused tunnel schema import left by incoming extraction and kept the app-icon authorization assertion within the test file cap. All 18 line-budget entries for paths in the lane diff match `wc -l`. `pnpm-lock.yaml` changed and `vp i` exited 0.

Incoming line-budget differences outside the lane diff remain at their integration values.

- `apps/server/src/cloud/bootService.ts` records 1293 lines with 1283 measured.
- `apps/server/src/git/GitManager.ts` records 3057 lines with 3048 measured.
- `apps/server/src/mcp/OrchestratorMcpService.ts` records 3858 lines with 3833 measured.
- `apps/server/src/vcs/GitVcsDriver.ts` records 1719 lines with 1717 measured.
- `apps/server/src/vcs/GitVcsDriverCore.ts` records 5329 lines with 5314 measured.

### Focused verification

Whole changed SSH files, the fixture's direct consumers and the fix-round workspace focus ran together with exit 0. There were 543 passed and two skipped in 28 files. With `GOAT_TEST_TMP_GUARD=fail` from `apps/server`, the seven selected whole files exited 0 with 111 passed.

| File | Passed | Skipped |
|---|---:|---:|
| `packages/ssh/src/command.diagnostics.test.ts` | 8 | 0 |
| `packages/ssh/src/penAlias.test.ts` | 8 | 0 |
| `packages/ssh/src/penConfigFile.test.ts` | 1 | 0 |
| `packages/ssh/src/penRoute.test.ts` | 12 | 0 |
| `packages/ssh/src/runtimeFactsScripts.test.ts` | 20 | 0 |
| `packages/ssh/src/runtimeProbe.invocations.test.ts` | 28 | 0 |
| `packages/ssh/src/runtimeWindows.test.ts` | 17 | 0 |
| `packages/ssh/src/tunnel.client-session.test.ts` | 14 | 0 |
| `packages/ssh/src/tunnel.core.test.ts` | 131 | 0 |
| `packages/ssh/src/tunnel.ensure-flight.test.ts` | 10 | 0 |
| `packages/ssh/src/tunnel.existing-only.test.ts` | 15 | 0 |
| `packages/ssh/src/tunnel.failure-parity.test.ts` | 19 | 0 |
| `packages/ssh/src/tunnel.launch-identity.test.ts` | 6 | 2 |
| `packages/ssh/src/tunnel.managed-reuse.test.ts` | 2 | 0 |
| `packages/client-runtime/src/connection/catalogHost.test.ts` | 16 | 0 |
| `apps/web/src/remoteOpen.test.ts` | 21 | 0 |
| `apps/web/src/components/commandPaletteFindItems.test.tsx` | 1 | 0 |
| `apps/web/src/state/primaryEnvironment.test.ts` | 3 | 0 |
| `apps/web/src/contextMenuFallback.keyboard.browser.test.ts` | 6 | 0 |
| `apps/web/src/components/ChatMarkdown.browser.test.tsx` | 34 | 0 |
| `apps/web/src/components/files/FileBrowserPanel.browser.test.tsx` | 17 | 0 |
| `apps/web/src/components/preview/PreviewView.browser.test.tsx` | 19 | 0 |
| `apps/web/src/components/settings/CloudMachinesSettings.browser.test.tsx` | 3 | 0 |
| `apps/web/src/components/settings/ConnectionEnvironmentsSection.browser.test.tsx` | 25 | 0 |
| `apps/desktop/src/preview/Manager.helpers.test.ts` | 6 | 0 |
| `apps/desktop/src/preview/Manager.test.ts` | 65 | 0 |
| `apps/desktop/src/updates/DesktopUpdates.sharedHome.test.ts` | 1 | 0 |
| `apps/desktop/src/updates/DesktopUpdates.test.ts` | 35 | 0 |
| `apps/server/src/assets/NativeAppIconResolver.test.ts` | 1 | 0 |
| `apps/server/src/background/KeepAwake.test.ts` | 7 | 0 |
| `apps/server/src/auth/RpcAuthorization.test.ts` | 48 | 0 |
| `apps/server/src/process/externalLauncher.test.ts` | 33 | 0 |
| `apps/server/src/preview/ServerBrowser.desktopSize.test.ts` | 4 | 0 |
| `apps/server/src/preview/ServerBrowser.stopLoading.test.ts` | 7 | 0 |
| `apps/server/src/preview/ServerBrowserStream.test.ts` | 11 | 0 |

### READY receipt

On `4b4df3ba118c3f62c6f59845b842a7ea70c73fea`, `vp run check:changed origin/chase/t3-261114-next3` exited 0, comparing 110 files against the merged integration parent. All static checks passed, including typecheck for 39 packages. The server batch passed 5,080 tests and skipped 12 in 369 files. The workspace batch passed 8,436 tests and skipped 14 in 399 files. Total 13,516 passed, 26 skipped and zero failures. The gate did not cache the result after detecting an input change. The tracked worktree was clean and the tested SHA was verified before the push.

A plain fast-forward push updated `chase/t3-261114-next3-k8` from `dd6456ad38` to `4b4df3ba118c3f62c6f59845b842a7ea70c73fea`. The remote head was read back at the exact SHA.

NOT RUN: lane hosted CI, real-client P1, live SSH to a Pen member and a real shared-home desktop update.

## Fix round 2

Review base `4b4df3ba118c3f62c6f59845b842a7ea70c73fea`.

- **P2-1, C3.** The production preload decodes `AnnotationVoiceEvent` from the second payload argument. The original GOAT voice implementation (`d33086fbd6`, `apps/desktop/src/preload.ts`) paired that decoder with a sender that emitted the tab ID followed by the event. Exercise the guest event through the manager and preload in the existing guest-events suite. Main and preload keep their existing signature and schema.
- **P2-2, C4.** Upstream `79daf43c1c` (`apps/desktop/src/backend/DesktopBackendPool.ts`) checks that the new process is ready before releasing its marker. GOAT's SSH waiter (`packages/ssh/src/sharedHomeUpdateWait.ts`) already stops waiting when the runtime record is newer than the marker or its 30-second deadline elapses. Keep the shared marker for that existing waiter and remove the tunnel marker at its current cleanup point. Older SSH clients ignore the shared file and newer SSH clients retain their existing behavior with older desktops, including when the file is absent, expired, or malformed. Shared marker retention applies only to the explicitly shared home. No RPC or stored row changes. Verify a failed install with backend recovery held by a Deferred, and separately verify the tunnel marker is already gone.
- **P3, C2.** GOAT's preview menu already derives Find from `apps/web/src/components/preview/PreviewFindBar.tsx`, and `apps/web/src/shortcuts/dispatcher.ts` uses an explicit false to continue to the next scope. Use the same view eligibility for browser Find in the palette, view menus and route shortcuts, including a searchable read-only connection. Verify fallthrough and dispatch in the existing route shortcut browser suite.

### Commits and failing-first proof

All three commits are GOAT-authored, in `4b4df3ba11..59efd3bcf9`.

| Finding | Commit | Failure before fix |
|---|---|---|
| P2-1 annotation voice | `692e6f3f629140c5b37b3c4f8a82272feb4c76f2` | The production preload listener received zero events after the manager sent a valid guest event. |
| P2-2 failed desktop install | `beefe1b0b6b00a08855032945f380457264d5adb` | The shared-home marker was absent at the recovery-start barrier, where the tunnel marker was already cleared. |
| P3 Find | `59efd3bcf939497e65fae372035204a7d4f6d8df` | The fallback scope received zero calls on unavailable Find. A searchable read-only route received zero Find actions after claiming the key. |

Running `vp test run` on the three whole regression files before the fixes exited 1 with four expected failures and six passes. The red run used `apps/desktop/src/preview/Manager.guestEvents.test.ts`, `apps/desktop/src/updates/DesktopUpdates.sharedHome.test.ts` and `apps/web/src/shortcuts/chatRouteCommands.browser.test.ts`.

### Focused verification

`vp test run --reporter=default --reporter=json --outputFile=<receipt> <files below>` exited 0 with 109 passed in 10 whole files and zero skips.

| File | Passed |
|---|---:|
| `apps/desktop/src/preview/AnnotationVoiceRelay.test.ts` | 1 |
| `apps/desktop/src/preview/Manager.guestEvents.test.ts` | 5 |
| `apps/desktop/src/updates/DesktopUpdates.sharedHome.test.ts` | 1 |
| `apps/desktop/src/updates/DesktopUpdates.test.ts` | 35 |
| `apps/web/src/components/ReopenClosedViewShortcut.browser.test.tsx` | 8 |
| `apps/web/src/components/commandPaletteFindItems.test.tsx` | 1 |
| `apps/web/src/components/preview/PreviewView.browser.test.tsx` | 19 |
| `apps/web/src/shortcuts/chatRouteCommands.browser.test.ts` | 4 |
| `apps/web/src/shortcuts/dispatcher.browser.test.ts` | 7 |
| `packages/ssh/src/runtimeProbe.invocations.test.ts` | 28 |

`git merge-tree --write-tree HEAD origin/chase/t3-261114-next3` exited 0 against `78bcbf193331327e4b88e65e522ceb318b67db14`. The existing integration merge base is `d4dfd457571834bb2c3c85984e64f5abd4af0e5d`. The lockfile did not change. `wc -l` measured 3611 lines for `Manager.ts` and 1485 for `DesktopUpdates.ts`, matching their budget entries.

P1 for the coordinator covers dictation in an annotation, Find from the browser menu, palette and chord, and failed-install recovery with a reconnect to the same home.

### READY receipt

`vp run check:changed origin/chase/t3-261114-next3` exited 0 on `59efd3bcf939497e65fae372035204a7d4f6d8df`, comparing 112 files since `d4dfd4575718`. Format, lint, both Knip passes, GraphQL, agent surface audit, context budget and typecheck for 39 packages passed. The server batch passed 5,080 and skipped 12 in 369 files. The workspace batch passed 8,439 and skipped 14 in 399 files. Total 13,519 passed, 26 skipped and zero failures.

From `apps/server`, `GOAT_TEST_TMP_GUARD=fail vp test run src/assets/NativeAppIconResolver.test.ts src/auth/RpcAuthorization.test.ts src/background/KeepAwake.test.ts src/preview/ServerBrowser.desktopSize.test.ts src/preview/ServerBrowser.stopLoading.test.ts src/preview/ServerBrowserStream.test.ts src/process/externalLauncher.test.ts` exited 0 with 111 passed in seven files and zero skips.

After the gate, the latest fetched integration head `3d683c091e517f93c2fa6fefb487b9af60f28fce` was also conflict-free by `git merge-tree --write-tree HEAD origin/chase/t3-261114-next3` with exit 0 and the same merge base. A plain fast-forward push updated K8 from `4b4df3ba11` to `59efd3bcf939497e65fae372035204a7d4f6d8df`. `git ls-remote` verified the exact head.

NOT RUN: hosted lane CI, integrated P1, a live shared-home installer/SSH reconnect, and dependency reinstall (lockfile unchanged).

## Review round 3 Find follow-up

C1 subscription change on the fast-forwarded integration head `b95bc9ddbdbc330494a708a6cf08db919d55ea06`. GOAT already uses a derived boolean for preview automation ownership in `apps/web/src/previewStateStore.ts` (`agentDrivenTabAtom`). Find uses the same subscription pattern alongside a constant false atom for a missing tab or incomplete bridge. The render-isolation regression drives the production stores through eligible, ineligible and closed-preview states.

One GOAT-authored commit, `fa93d0e5ec1df325425ad57b192a2f5155540f55`. `git merge --ff-only origin/chase/t3-261114-next3` and `vp i` both exited 0. The incoming integration lockfile changed and the follow-up leaves it untouched.

- `vp test run apps/web/src/components/preview/findAvailability.browser.test.tsx` exited 1 before the fix. Changing back-navigation state caused one extra render with the same eligibility value.
- Whole focused files via `vp test run` exited 0 with 50 passed and zero skips. Find availability 1, reopen shortcut 8, palette composition 17, palette Find items 1, preview view 19, chat route commands 4.
- `vp run check:changed origin/chase/t3-261114-next3` exited 0 on the pushed SHA. It compared two changed files, passed typecheck for two packages and passed 2,023 tests in four files with zero skips. It did not cache the result because files changed during the run. The tracked worktree was clean at push.
- Plain push exited 0. `git ls-remote` verified lane head `fa93d0e5ec1df325425ad57b192a2f5155540f55`.

NOT RUN: hosted lane CI, integrated real-client P1, and separate guarded server tests (no server files changed).
