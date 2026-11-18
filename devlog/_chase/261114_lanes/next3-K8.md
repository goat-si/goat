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
