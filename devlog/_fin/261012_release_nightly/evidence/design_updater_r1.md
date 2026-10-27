## A. App auto-update (D-9, N-11)

Keep `autoDownload=false` and `autoInstallOnAppQuit=false` for every policy. The app owns scheduling, backend shutdown and install recovery.

### Policy, persistence and state wiring

- In `packages/contracts/src/ipc.ts`, add `DesktopUpdateInstallPolicySchema` and its inferred type: `"restart-when-idle" | "install-on-quit" | "paused"`. Add `installPolicy`, `pendingRestartReason: null | "busy" | "unknown" | "paused"`, `pendingUpdate: null | { version; channel; downloadedAt }`, and `recoveryStatus: null | "restoring" | "needs-network"` to both `DesktopUpdateState` and `DesktopUpdateStateSchema`. Add `DesktopBridge.setUpdateInstallPolicy(policy)`.
- In `settings/DesktopAppSettings.ts`, persist `updateInstallPolicy`, defaulting to `"restart-when-idle"`, and nullable `pendingUpdate` in `DesktopEnvironment.desktopSettingsPath` (`<stateDir>/desktop-settings.json`). Extend interface, defaults, document schema, normalization, sparse serialization, setters and test layer. Use the existing synchronized settings update and temporary-file replacement path.
- Carry all new fields through `updates/updateMachine.ts:createInitialDesktopUpdateState` (~:18), `DesktopUpdates.ts:createBaseUpdateState`, configuration and channel-reset paths. Reducers preserve policy/pending fields unless explicitly transitioning them. A persisted pending record must **never** initialize `downloadedVersion`.
- Add the policy method through `ipc/channels.ts`, `ipc/methods/updates.ts`, `ipc/DesktopIpcHandlers.ts` and `preload.ts`. The handler calls the updater service, which persists before broadcasting and schedules policy reevaluation. Extend relevant main-process service requirements/layers.

`paused` suppresses automatic downloads and installation; an admitted download may finish and remain cached. Metadata checks and explicit Download/Install remain available. Unpausing schedules reevaluation immediately. `install-on-quit` downloads automatically but performs no idle installation.

In `applyAutoUpdaterChannel` (~~:394), set `allowDowngrade=false` after setting the channel. Preserve the existing explicit-channel-change exception (~~:1005): temporarily enable downgrade for that check, restore false in its finalizer, then release the channel reservation.

### Download scheduling after reservation release

`update-available` is delivered through `runEffect(handleUpdateAvailable(info))` (~:953); its effect can finish before or after the check promise. Calling download only from that callback, or skipping it while reserved, loses legitimate updates.

Add one scoped coordinator with a coalescing wakeup queue. Subscribe/start it before updater listeners and pollers. Two producer hooks cover both event orders:

```ts
// handleUpdateAvailable: after accepted availability is committed
yield * wakeAutomaticUpdateCoordinator;

// finishUpdateAction: after activeUpdateActionRef is cleared
yield * PubSub.publish(finishedUpdateActions, action);
yield * wakeAutomaticUpdateCoordinator;
```

Keep the existing exact release sites:

```ts
check.pipe(Effect.ensuring(finishUpdateAction("check")));
channelChange.pipe(Effect.ensuring(finishUpdateAction("channel")));
download.pipe(Effect.ensuring(finishUpdateAction("download")));
```

The coordinator rereads configuration, quitting state, policy, channel, update state and reservation. While reserved, retain work; the release hook wakes it again. When unreserved and eligible, call existing `downloadAvailableUpdate`, which acquires `"download"` itself. Automatically download accepted nightly availability unless paused.

Use a check-generation retry latch: one automatic download attempt per successful availability/check generation. Failure stays retryable manually or after the next poll; the download-release wakeup must not create an immediate retry loop. Revalidate the selected channel before admission.

After `handleUpdateDownloaded` (~:876), persist `{version, channel, downloadedAt}` before publishing app readiness, then wake the coordinator. It waits for the download reservation to release before attempting installation.

### Durable pending recovery

Installed electron-updater **6.8.9** requires metadata first: `AppUpdater.js:389` fetches `getLatestVersion`; `downloadUpdate` requires `updateInfoAndProvider` (~~:435). Cache validation occurs later in `executeDownload` (~~:604); a cache hit restores its download helper and emits completion without transferring the artifact again.

On startup:

1. Load the pending record. Clear it when its version is already installed/superseded, or its channel differs from the selected channel. Explicit channel changes clear pending readiness and the old record.
2. Otherwise expose `pendingUpdate`, keep `downloadedVersion=null`, and set recovery to `"restoring"` unless paused.
3. Run the normal startup check, then the coordinator’s download path. A matching cached artifact passes electron-updater’s validation and restores readiness. If the feed advertises a newer version, download that version and replace the record only after completion.
4. On metadata/network failure, retain the record and cached bytes, set `"needs-network"`, and retry through normal polling/manual Check. Do not enable Install or idle/quit installation from the record alone.

Thus pending intent survives offline restarts; offline install readiness does not. Do not access private updater helpers or synthesize download events. Paused startup retains the record without automatic cache restoration. Persistence failures expose a retryable error and suppress automatic installation; successful installation clears the record on the next launch, never merely when `quitAndInstall` is invoked.

### Idle detection, including WSL

Add `updates/DesktopBackendActivity.ts`; inspect **every instance in `pool.list`**, matching the installer’s stop set (~:637). Use `instance.currentConfig.httpBaseUrl`, not an invented configuration port.

For native backends, construct `/.well-known/t3/activity` from that URL, replacing its hostname with loopback while preserving protocol and port. Bound requests to two seconds and decode `SshServerActivity` (`environmentHttp.ts:449`). Require a ready snapshot with `activePid`, and require response `pid === activePid`. Reread the snapshot/config after probing; changed PID/config, readiness loss, malformed response, timeout or forbidden response means unknown. Only fully stopped instances—no PID, no desired run, no scheduled restart—count as idle without probing.

**Decision: running WSL instances report unknown in this phase.** Configuration deliberately advertises the distro address (`DesktopBackendConfiguration.ts:638,746`), while `http.ts:325–334` restricts activity to loopback peers. Moreover, `snapshot.activePid` is the Windows `wsl.exe` child PID; the endpoint reports the Linux server PID. An in-distro curl request alone cannot validate that identity. This conservative result requires no new authentication or Linux process-identity protocol. Detect WSL from resolved configuration, including WSL-only primary instances, not just an instance-ID prefix.

Report: “Automatic restart postponed: WSL activity cannot be verified.” Disabled/stopped WSL does not block.

Probe immediately after readiness and every 60 seconds while pending. Busy/unknown postpones. Before install admission, recheck policy, expected version and pool membership/snapshots; any change postpones. Route admitted installs through `installDownloadedUpdate(expectedVersion)` and its existing recovery.

**An open macOS window is not a veto.** N-11’s default promises unattended convergence; backend work determines idleness. Users who want to choose when the window closes select `install-on-quit` or `paused`.

### App-owned quit installation

`BaseUpdater.js:69` registers its quit handler only during download completion when the flag is already true. `MacUpdater.js:218–253` uses the flag to trigger native Squirrel fetching. Keep it false throughout; do not toggle it as a policy implementation.

Extend `DesktopLifecycle.ts:handleBeforeQuit` before it sets `desktopState.quitting` or requests global shutdown:

- Prevent the initial quit synchronously and serialize repeated quit requests.
- For `install-on-quit` with verified in-session readiness, flush window bounds and call the existing prepared install path. It reserves installation, writes the restart marker, stops **all** pooled backends, then calls `quitAndInstall`.
- On accepted installation, keep updater services alive and await the updater-controlled quit. Do not enter ordinary shutdown or call another `app.quit()` from a `finally`; macOS may still be fetching the cached ZIP through its local Squirrel proxy.
- Preserve the synchronous `onBeforeQuitForUpdate` window destruction/bypass.
- No readiness or refused admission: continue ordinary shutdown, preserving the pending record. Install failure: retain pending state, recover backends and leave the app running with the error.

Signals and explicit relaunches retain their existing shutdown paths.

### Settings and focused proof

In `components/settings/SettingsPanels.tsx`, add a desktop-only policy selector beside Update Track. Register its searchable-setting metadata. In `components/desktopUpdate.logic.ts`, provide status text for busy, unknown/WSL, paused, quit installation and recovery requiring connectivity. Use state subscription broadcasts; ordinary browser clients expose no desktop updater controls.

Extend `DesktopUpdates.test.ts`/`updatesTestHarness.ts` using `it.effect`, `Deferred`, emitted callbacks and `TestClock`:

- Availability before check completion and callback completion after reservation release; no download while check/channel is held, exactly one afterward.
- Paused/resumed policy, failed-download retry without a tight loop, channel-switch downgrade restoration.
- Idle installation after download release; busy→idle; unknown; PID/config/pool change; stopped instances; native-primary plus running/stopped WSL; WSL-only primary.
- Persisted recovery across two service instances; matching cache completion, newer feed, offline metadata failure, paused recovery and persistence failure.
- All backend stops precede `quitAndInstall`; existing install recovery remains intact.

Add focused lifecycle quit-ordering tests, settings round trips, state-schema/initialization tests, and fake-fetch activity tests. No servers or browser verification are required for this design pass.

### Open risks

- Running WSL deliberately postpones automatic restart until Linux process identity can be verified.
- Activity probing cannot atomically prevent new work between the final probe and shutdown.
- Offline restart recovery requires connectivity; cache presence alone cannot restore public updater readiness.
- macOS native installation is asynchronous and follows the existing relaunch behavior; quit-policy wording should make that clear.
