## B2. Idle-only convergence + remote lock (N-12)

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

### Remote mutex and recovery

Use atomic mkdir, but place the mutex at the **shared server-home scope**:

```sh
REPLACEMENT_LOCK="$DEFAULT_SERVER_HOME/ssh-launch/replacement.lock"
mkdir "$REPLACEMENT_LOCK"
```

This deliberately adjusts N-12’s per-`STATE_DIR` location: `command.ts:71-83` hashes aliases into different directories, although they can address the same backend.

After mkdir, enter that directory in a subshell and atomically link a complete, prewritten immutable `owner.<nonce>` record into it. Record remote host identity, UID, shell PID, process start identity, and random nonce. Confirm the canonical lock path still identifies the acquired directory and contains this owner before permitting mutations. An unsuccessful initialization yields contention.

Choose **dead-owner-only recovery**, with no age/lease takeover:

- Prove the recorded process instance dead using a successful process inspection: absent PID, or a different start identity for that PID. Host/UID ambiguity or inspection failure is unknown.
- Live owners remain protected indefinitely, including paused owners exceeding ten minutes.
- Re-read the immutable owner record, remove only that exact nonce file, and use `rmdir`; never recursively delete the canonical directory.
- Competing recoverers cannot remove a successor’s differently named owner. A delayed `rmdir` can only remove an empty, not-yet-owned directory; the initializing client must detect the detached directory before any mutation.
- Empty/malformed owner directories yield contention indefinitely; elapsed time alone never authorizes reclamation.

EXIT/HUP/INT/TERM cleanup removes only this attempt’s owner marker and then `rmdir`. Do not replace existing cleanup traps; compose them. Every GOAT path publishing a shared runner or stopping/starting this backend must honor this mutex, including the shared runner setup (`tunnel.ts:822`) and explicit stop path. Pairing/MCP reuse must remain read-only during pending replacement.

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

### Open risks

- Legacy runtimes lacking an activity endpoint remain pending until externally resolved; unknown is never treated as idle.
- Idle observation and signalling retain a small race; atomic server-side draining would require broader scope.
- Empty lock directories require verified manual recovery; automatic age-based deletion is intentionally excluded.
- Older installed clients ignore this mutex; D-8’s two-Mac bootstrap shutdown remains necessary.
