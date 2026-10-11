# 030 — wp3 wiring: app auto-update, SSH public supply and idle convergence, protocol 1001

Depends on wp1. Known residual risks (accepted, recorded for D): running WSL backends postpone automatic restart (unknown); idle probe → stop keeps a small race without server-side draining; legacy runtimes without an activity endpoint stay pending; older installed clients ignore the remote mutex, so the 050 §11 bootstrap still quits both old apps first. Two disjoint lanes: (A) desktop updater + settings + web UI, (B) SSH + protocol + CLI listing. Re-verify anchors at cycle start; tunnel.ts line numbers drift.

## A. App auto-update (D-9, N-11; audit r1 blockers 7–8, design lane `evidence/design_updater_r1.md`)

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

## B1. SSH public HTTPS supply (N-12)

- `packages/ssh/src/runtimeArchiveHttp.ts` (NEW): `downloadRuntimeArchiveWithHttps(directory, version, platformKey, fetchImpl?)` mirroring `runtimeArchiveGh.ts` (lock/recheck cache, scoped staging dir, fetch `SHA256SUMS` and asset from `cliReleaseDownloadBaseUrl` (`cliRelease.ts:57`) + asset name, verify sha256, sidecar-first publish) returning `{ fileName, bytes, sha256 }`. 404 → typed "not published" error so the gh fallback can run.
- `packages/ssh/src/tunnel.ts` (~:1867): `bundled ?? cache ?? https ?? gh` — gh only when https reports not-published or network failure, error message names both sources.
- Tests: success, checksum mismatch (no publish to cache), missing asset → gh fallback.

## B2. Idle-only convergence + remote lock (N-12; audit r1 blockers 5–6, design lane `evidence/design_ssh_r1.md`)

All three replacement reasons—older compatible, verified legacy takeover, and owned protocol-incompatible—use one replacement transaction. Busy/unknown preserves the live process, published runner, and ownership files. Newer runtimes are never replaced.

### Result contract and reachable paths

Replace `RemoteLaunchResult` (`packages/ssh/src/tunnel.ts:312`) with a discriminated union; pending without a usable server must not require a port:

```ts
type PendingReplacement = {
  reason: "busy" | "unknown" | "contended";
  replacement: "older" | "legacy" | "incompatible";
  requestedVersion: string;
  liveVersion: string;
};

type RemoteLaunchResult =
  | {
      status: "ready";
      remotePort: number;
      serverKind?: "external" | "managed";
      selectedVersion: string;
      refresh?: "replaced";
      pending?: PendingReplacement;
    }
  | { status: "pending"; pending: PendingReplacement };
```

Use corresponding Effect schemas, retaining integer/port validation for `ready`.

The complete consumption chain is:

1. Shell emission replaces `tunnel.ts:1267-1275`; an early `emit_pending` exits **successfully**, before compatible reuse.
2. Schema/decode: `tunnel.ts:312`, `:328`, `:352`.
3. Transport: `packages/ssh/src/command.ts:297` returns successful stdout; pending is not `SshCommandError`. Its scoped timeout (`:305-325`) remains a transport failure, not proof the remote transaction stopped.
4. `launchOrReuseRemoteServer` (`tunnel.ts:1920`, decode `:1960`) handles pending before port validation (`:1970`) and selected-runtime caching (`:1985`). Only ready has a usable `selectedRuntime`.
5. Manager: `createTunnelEntry:2673` records the result at `:2683` **before** port reservation, forwarding, or pairing. Pending without ready returns without creating a tunnel. `ensureEnvironment:2855` returns bootstrap-or-pending.
6. Desktop/IPC: update `DesktopSshEnvironment.ts:59/:146`, `packages/contracts/src/ipc.ts:411/:420/:453/:1170`, `ipc/methods/sshEnvironment.ts:130`, and `preload.ts:63/:145`. Add a `type: "ssh-runtime-pending"` ensure result carrying target and pending fields; preserve the existing password-cancellation variant.
7. Both consumers, `apps/web/src/connection/platform.ts:184` and `:288`, detect pending immediately after ensure, before pairing/descriptor/bearer calls (`:198/:205/:303/:309`). Convert it to `ConnectionTransientError`, reason `remote-unavailable`.

8. Server dispatch (audit r2 blocker 5): `apps/server/src/sshRemote/SshRemoteDispatch.ts` launch (~~:598) and tool call (~~:704) narrow the ensure result before `connected.add`, `sessionFor`, `httpBaseUrl` or any MCP call: pending → `failure("host_unavailable", "<alias>'s GOAT runtime is being replaced when its current work finishes; retry later")` (contended/unknown variants worded like the UI). Tests: pending launch issues no session and registers no connected host; pending tool call sends nothing.

Pending-incompatible therefore opens no forward, issues no credential, and sends no work. Use the existing **Connections settings machine status tooltip** (`ConnectionsSettings.tsx:1605`), fed by supervisor backoff (`packages/client-runtime/src/connection/supervisor.ts:979`) and `connectionStatusText` (`presentation.ts:68`). Detail: “Remote runtime will be replaced when its work finishes”; unknown adds “Waiting for a verified idle response”; contention says “Another client is replacing the remote runtime.” Initial connection errors also use `ConnectionsSettings.tsx:2558`. No new UI state machine.

### One replacement transaction

Make `check_live_protocol` (`tunnel.ts:726`) observational: protocol compatibility, verified ownership, live version/PID/port, and replacement reason. Remove its activity decisions (`:773-782`) and the legacy exclusion `REFRESH_IF_IDLE != 1` (`:748`).

Legacy verification remains `verify_legacy_identity` (`:992`): regular files, retained-runner hash, exact invocation, UID/start identity. It grants prospective replacement authority without committing an identity. Do not call `verify_owned_identity` for uncommitted legacy ownership.

`prepareRemoteRuntime:1771-1799` chooses requested candidate bytes for replacement, but keeps requested version separate from the compatible live selection. `keepExistingRunner` and secondary pairing/MCP preparation cannot initiate replacement.

Install and validate the candidate first (`:869-909`), without publishing it. Replace publication at `:927` and the upgrade branch at `:1179` with:

```sh
acquire_replacement_lock || emit_pending contended
reprobe_live_and_classify
check_candidate_protocol
check_retained_runner
assert_not_newer
verify_replacement_authority
activity="$(read_refresh_activity)"
[ "$activity" = idle ] || emit_pending "$activity"

# Only short ownership checks/legacy commit intervene before signalling.
commit_legacy_identity_if_needed
verify_same_process_identity
kill "$LIVE_PID"
wait_for_pid_exit "$LIVE_PID"
assert_old_process_exited
publish_selected_runner
start_and_verify_selected_server
```

Keep the lock until readiness and new identity publication finish. Preserve legacy rollback (`:1037`) when termination fails; publishing the runner **after confirmed termination** also preserves owned runtimes’ runner bytes on stop failure.

Activity always uses the pinned candidate helper (`:1051`) against the verified live PID/port. Its PID-validated remote-loopback query already exists in `apps/server/src/cli/sshHelper.ts:390/:442`. Missing endpoint, malformed output, timeout, or PID mismatch means unknown.

Re-probe version under the lock. Add a small `__ssh-helper compare-version` subcommand beside `sshHelper.ts:442`, using shared `compareSemverVersions`; consume its validated `older|equal|newer` output from the pinned candidate. Do not implement lexical shell comparison. Newer-compatible reuses the live runtime; newer-incompatible returns “Remote runtime is newer than this app; update the app” with no replacement or retry intent. Unverifiable ownership remains a preserved-process error.

For busy/unknown/contention, emit ready-plus-pending only after independently verifying compatible reuse with the retained live runner. Otherwise emit pending without a port; never call `reuse_live_server:1153` for incompatible legacy/owned runtimes. Neither branch publishes candidate bytes or legacy identity.

### Remote mutex and recovery (rewritten after audit r2 blocker 6)

One host-scope lock serializes every GOAT replacement on a remote home, because `command.ts:71-83` hashes aliases into different state dirs that can still address one backend:

```sh
LOCK="$DEFAULT_SERVER_HOME/ssh-launch/replacement.lock"           # symlink
RECOVERY="$DEFAULT_SERVER_HOME/ssh-launch/replacement.recovery"   # symlink
OWNER="$(hostname)|$(id -u)|$$|$(process_start "$$")|$NONCE"
acquire()  { ln -s "$OWNER" "$LOCK" 2>/dev/null; }                 # atomic; owner travels in the link
release()  { [ "$(readlink "$LOCK")" = "$OWNER" ] && rm -f "$LOCK"; }   # only our own link
```

- **Acquire** is a single `ln -s`; there is no window where the lock exists without an owner record. After acquiring, re-probe identity, version and activity before mutating.
- **Owner is dead** only when, on the same host and UID, the recorded PID is absent or its start identity differs (`process_start` reads `ps -o lstart=`). Any inspection failure, other host or other UID is "unknown" → contention, never recovery. Elapsed time never authorizes recovery; live or paused owners stay protected indefinitely.
- **Recovery is serialized** by a second lock taken the same way: `ln -s "$OWNER" "$RECOVERY"`. Holding it, the recoverer re-reads `readlink "$LOCK"`; only if it still names the owner proven dead does it `rm -f "$LOCK"`, then releases `$RECOVERY` (own-link check) and retries `acquire` once. Successor-safety: the lock link can change only by its owner's `release` (a dead owner cannot run it) or by a recoverer, and recoverers run one at a time while re-checking under `$RECOVERY`, so a recoverer never removes a successor's lock. Acquirers do not need `$RECOVERY`.
- A recoverer that dies while holding `$RECOVERY` leaves it in place; later recoverers report contention with the message "remove <path> after checking that no GOAT client is replacing this runtime" (user guide). The recovery critical section is one readlink and one rm, so this needs a crash in that instant; it is never cleared automatically.
- EXIT/HUP/INT/TERM traps call `release` (own link only) composed with existing traps. Every GOAT path that publishes the shared runner or stops/starts this backend takes the lock: replacement, shared runner setup (`tunnel.ts:822`), explicit stop. Pairing/MCP reuse stays read-only.
- Contention returns the pending result `reason: "contended"` whether or not a compatible tunnel exists.

### Manager retry and cancellation

Beside `tunnels` (`:2517`), add:

```ts
const pendingReplacements = new Map<
  string,
  {
    target: DesktopSshEnvironmentTarget;
    requestedRunner: RemoteT3RunnerOptions;
    pending: PendingReplacement;
    generation: number;
    nextAttemptAt: number;
  }
>();
```

Store intent even when no tunnel exists or pairing fails. Never derive the requested version from `entry.selectedRuntime`, which may describe the older reused runtime.

One manager-scoped ten-minute fiber iterates pending targets using `withTargetLock:2523`. Background attempts use cached authentication or noninteractive batch mode; they cannot raise password prompts. Reconnect/explicit retry attempts immediately. The healthy cached-entry path (`:2790-2821`) must reconcile pending intent before returning; busy compatible entries retain their healthy forward.

After successful replacement, remove the old entry before closing its scope, preventing its finalizer (`:2735-2755`) from stopping the successor. Recreate the forward on the previous local port and update selected runtime; existing sockets reconnect through their unchanged URL. Without an old entry, cache the new forward; normal supervisor retry completes pairing.

At `:2893`, allow refresh when startup is unconsumed **or pending intent exists**. At `:2918`, consume only a settled successful result, never pending. Track decisions by target and requested version.

Disconnect/removal (`:2933`) invalidates the generation, cancels retry, and closes only local forwarding when replacement is pending. Manager shutdown follows the same rule. In-flight results cannot resurrect cancelled intent; SSH interruption does not imply remote rollback.

### Focused tests

Extend `makeProtocolFixture` (`tunnel.protocol.fixture.ts:418` snapshots/events), using fixture barriers and TestClock for manager timing:

- Each replacement reason: busy/unknown preserves PID, runner, identity; later idle replaces once.
- Preliminary idle then final busy/unknown preserves everything; wrong activity PID is unknown.
- Legacy pending never commits identity; incompatible pending creates no forward/pairing/MCP work.
- Newer compatible/incompatible never stops; include numeric prereleases and a newer runtime appearing under lock.
- Two managers and differing aliases serialize publication/stop/start.
- Live/paused owner beyond ten minutes remains protected; dead-owner recovery, concurrent recovery, ownerless contention, successor-safe cleanup.
- Reconnect, interval, healthy cached entry, pairing failure, and transport timeout retain intent correctly.
- Cancellation prevents retries/resurrection and remote stop; replacement rebuilds forwarding without successor termination.
- IPC schema round-trip and both platform consumers show pending before authentication.

## B3. Protocol 1001 (N-13)

- `packages/shared/src/sshRuntimeProtocol.ts:2`: `SSH_RUNTIME_PROTOCOL_VERSION = 1001` with a mapping comment ("GOAT 1001 ↔ upstream 1").
- `packages/contracts/src/environment.ts:13-14`: `ORCHESTRATION_PROTOCOL_VERSION = 1001`; `ORCHESTRATION_PROTOCOL_VERSION_TEXT = \`${ORCHESTRATION_PROTOCOL_VERSION}\` as const`; mapping comment ("GOAT 1001 ↔ upstream 2").
- Replace current-protocol literals with the constants at every anchor in L2 §2 (ssh tests/fixtures, `resolver.test.ts:243,281`); keep intentional legacy literals.
- Tests: text equals String(number); HTTP auth rejects header "2"; a 1001 client classifies a protocol-2 server (0.0.45) as "server too old"; SSH helper identity with protocol 1 is incompatible.

## B4. CLI release listing cache/retry

`apps/server/src/cli/update.ts:58`: retry transient failures (5xx, 403 secondary rate limit, network) twice with backoff; cache the release list per repository+channel for 10 minutes in `<T3 home>/cache/release-index.json`; error suggests `T3CODE_VERSION`. Test with a fake fetch.

## Proof

`vp test run` on touched desktop/web/ssh/contracts/client-runtime/server tests; targeted typecheck of desktop, web, ssh, contracts, client-runtime, shared, server; `rg -n 'orchestrationProtocol=2'` returns only intentional legacy cases.
