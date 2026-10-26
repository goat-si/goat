# SSH

SSH is how one environment reaches a project on another machine. The local process does not mount
the remote disk. It either runs a remote shell for a browse, or it starts GOAT on that host and
talks to the remote server's own `/mcp`.

The [state roots](settings-and-storage.md#state-roots) contract is what the remote process uses
once it is up: `$HOME/.goat`, not the local default.

## Package

`packages/ssh` (`@goat/ssh`) has no root export. `packages/ssh/package.json` exports `./auth`,
`./command`, `./config`, `./errors`, `./hostKey`, and `./tunnel`.

`discoverSshHosts` in `packages/ssh/src/config.ts` reads the user's OpenSSH directory: `Host` and
`Include` aliases from `config`, plus hostnames from `known_hosts`. A discovered host is
`DesktopDiscoveredSshHost` in `packages/contracts/src/ipc.ts` (`alias`, `hostname`, `username`,
`port`, `source`). The source is `ssh-config` or `known-hosts`.

`packages/ssh/src/command.ts` builds the `ssh` argv and runs it. `packages/ssh/src/auth.ts` is the
password-prompt and child-environment helper. `packages/ssh/src/errors.ts` is the tagged errors
(`SshCommandError`, `SshLaunchError`, `SshPairingError`, and the rest).
When ssh itself cannot connect (exit 255 with a connect, resolve, or banner timeout), the
`SshCommandError` message names the alias and the address ssh dialled. `prepareRemoteRuntime`
passes SSH errors through unchanged, so an unreachable host never reads as a runtime archive
problem; only an `SshLaunchError` with reason `archive-unavailable` asks for an archive.

## Remote server

`launchOrReuseRemoteServer` and `startSshTunnel` live in `packages/ssh/src/tunnel.ts`. The tunnel
is `ssh -L` onto the remote loopback port. The embedded launch script sets
`DEFAULT_SERVER_HOME="$HOME/.goat"` and unpacks runtimes under
`$HOME/.goat/runtime/goat/versions/`. `SshEnvironmentManager` owns that tunnel's lifetime.
`apps/server/src/sshRemote/SshWorkspaceSync.ts` prints the label `GOAT_HOME` followed by `$HOME`
when it fetches a branch back. That label is not an environment variable `resolveBaseDir` reads.

### Local SSH ownership

On POSIX, `master.ts` starts one private `ssh -M -N` per resolved target in a
manager. Commands reuse its control socket; forwards are added with `-O forward`
and removed with `-O cancel` using the identical `-L` spec before the master is
killed through its captured process handle. `ControlPersist=no` and the same
owner-pipe fence as standalone forwards prevent a master surviving an owner crash.
The fresh, owner-checked 0700 runtime directory under `/tmp` contains both
askpass and the socket; a 12-hex SHA-256 prefix covers the resolved target and
effective `ssh -G` config, including proxy and identity settings. The path budget
reserves 17 bytes for OpenSSH's temporary suffix plus a terminating NUL within
macOS's 104-byte socket limit. A separate directory per lifetime keeps teardown
from reaching a successor's socket.

A failed or exited master falls back to standalone SSH. Windows stays standalone.
An effective user ControlPath or enabled ControlMaster leaves command sharing to
OpenSSH's user configuration. The forward stays standalone and owner-fenced with
`ControlMaster=no`, `ControlPath=none`, and `ControlPersist=no`; GOAT never creates
a master in that case. Keepalive runs on the owned master and on commands,
including commands using `-S` in case OpenSSH falls back to a direct connection.
Git workspace transfers carry the same 15 s / three missed probes budget through
`GIT_SSH_COMMAND`. The RPC ping still owns detection
of a forward that remains alive but stops carrying bytes. `ssh.reconnect.cost`
counts all SSH spawns and reports `mastersStarted` and `controlCommands` separately
from authentication milestones, so local mux requests do not imply new handshakes.

### App server

A host user has one GOAT server that remote hubs and desktops reach. When the packaged GOAT app
runs there, that is the app's own server on `~/.goat/desktop`, which holds the threads the person
starts in the app. For runners with `attachAppServer` (the desktop app and the server's SSH
dispatch set it), `launchOrReuseRemoteServer` asks `probeAppServer`
(`packages/ssh/src/appServer.ts`) first: it reads `~/.goat/desktop/userdata/server-runtime.json`,
requires a live PID, a loopback answer on the recorded port, and the control token beside the
record, then reads the descriptor. A server that advertises `capabilities.runtimeSessions` and
whose protocol ranges are compatible is attached as `remoteServerKind: "app"`. GOAT never starts,
stops, drains, updates or adopts it, and writes none of its launch records for it. Only when no
app server runs, or it cannot serve this client (an older app, incompatible protocols, no `curl`,
unreachable on loopback), does the launch start or reuse the managed server below, and that
selection carries `appServerDeclined`. Windows hosts are not probed.

Credentials for an app attachment come from the app server itself:
`POST /.well-known/goat/runtime/session` (`apps/server/src/runtimeSessionRoute.ts`) takes the same
loopback peer and `runtime-control.token` as a drain and answers what
`goat auth session issue --json` and `goat auth pairing create --json` print. The token reaches
`curl` through its config on stdin. Running `goat auth session issue --base-dir ~/.goat/desktop`
with an installed runtime instead would open the app's live database with another build's
migrations.

The managed server sets `appServerLive` in its descriptor while an app server's record names a
live PID (`apps/server/src/environment/hostAppServer.ts`). A client reusing a managed forward
reconnects, and so lands on the app server, only once the managed server's activity probe answers
`idle` (`shouldMoveToAppServer`). Threads already running there finish where they started. Only an
ensure that reconnects at once drops the forward; background revalidation and the check right after
a launch leave it alone. A probe that cannot run counts as declined. If the app server refuses a
credential, that target uses the managed server for ten minutes and then probes the app again;
a ready-only request reports the refusal instead of switching servers. The two
homes keep separate databases; nothing is merged. While the managed server still runs, the app
lists its threads as **Headless server** (`apps/desktop/src/backend/DesktopHeadlessServer.ts`).
When the app quits, its forward fails and the next ensure starts or reuses the managed server.

> Decision record: [ADR-0024](decisions/ADR-0024-one-host-server.md)

### Shared runtime

When no [app server](#app-server) serves the host, one host user runs one SSH-managed server, and
every client shares it. The launch, pairing, MCP
session, stop, and log scripts keep their ownership records (`pid`, `port`, `managed`, `identity`,
`run-t3.sh`, `server.log`) in `~/.goat/ssh-launch/runtime` (`REMOTE_RUNTIME_STATE_KEY` in
`packages/ssh/src/command.ts`), whatever alias, hostname, or port the client dialled. A client that
finds a compatible live server attaches to it, so threads started from any client live in that
server's state and every client sees them.

Each start of `goat` costs about 0.4 s on a host, and the probe, launch, and pairing scripts ask
the same questions before every use. They record each successful answer in
`~/.goat/ssh-launch/facts`: an executable's version, protocol, commit time, and memory-scope
support under its path, inode, size, and times (only once it is 2 s old), and a live server's
protocol and compatibility under its runtime record and the start times of the PIDs it names.
The existing best-effort post-install cleanup round trip waits at most 2 s for that age gate,
then records these answers for the installed executable and runner before the first reconnect.
A changed, reinstalled, or removed executable, or a replaced or restarted server, misses and is
asked again, so the rechecks still guard every step. The probe prunes facts only when their
version path is absent, preserving installed versions and symlinks. Windows hosts record nothing.

A stale forward can fold the full probe into the launch command for a previously selected
owned runtime, including a deferred replacement, with no blocked update or acquisition failure.
The probe's answer and a fingerprint of the executable, live process records, runner and
ownership must match the last launch. The folded command holds the replacement mutex across
probe and attachment when a replacement is pending; a competing local owner gets a bounded wait
within that command. With no upgrade needed, unresolved lock contention can still attach after
revalidating the live server, retained runner, ownership and drain fence. If the owner
finished installing this client's requested version, the same command can verify and attach
that version. Other changes return the observed probe to normal selection. A deferred attach
keeps the original ten-minute retry deadline. Explicit refreshes and confirmations, first-connection
refreshes, and Windows hosts keep the separate probe. The cost log names the folded attempt
`runtime-probe-folded`; the launch still rechecks its selection before use.

HTTP readiness does not prove a runtime is accepting work during a drain. Attachment while an
upgrade is needed requires replacement-lock ownership. Lock-only contention can attach without
pending replacement metadata, but an instance-bound fence still blocks attachment after a lost
drain response or dead SSH owner. Under replacement ownership, the live helper retires the fence
when its instance is gone.
For the same live instance, an authenticated drain retry joins the active drain: cancellation
allows attachment again, a confirmed drain goes through the supervisor, and an unknown answer
keeps attachment blocked. An attach-only folded launch leaves this recovery to the scheduled
or explicit refresh. Recovering the mutex or waiting ten minutes alone does not clear the fence.
Clients predating this fence cannot enforce it.

The runner keeps `run-t3.sh` because independently updated clients and retained supervisors
use that path for reuse, replacement, and rollback. Its shell variables use `GOAT_*`;
only literal `T3_ARCHIVE_VERSION` and `T3_NODE_SCRIPT_PATH` declarations remain as metadata
for older clients that inspect the file without sourcing it. New readers prefer GOAT
declarations and also accept legacy runners.

The live `~/.goat/userdata/server-runtime.json` record and the server's descriptor decide identity.
Remembered launch files whose PID has exited are stale and do not block attaching
(`readLiveSshRuntimeProtocol` in `apps/server/src/cli/sshHelper.ts`). They never grant kill
authority either, because the launch script requires its PID file to name the live PID.

Ownership follows the server, not the client that started it. A live server this host user runs
as `~/.goat/runtime/goat/versions/<v>/goat serve --host 127.0.0.1 --port <p> --base-dir ~/.goat`
is GOAT's managed runtime even when its launch records are gone, for example after a manual
restart or a moved `ssh-launch` directory. The probe reports it as `liveAdoptable`, and an
owning launch holding the replacement lock writes identity, port, PID and `managed` for it
(`managed_orphan` and `adopt_managed_orphan` in `packages/ssh/src/tunnel.ts`). From then on it
updates through its own drain like any owned runtime; a rollback without a retained runner
restarts it through this client's runner pinned to its version. Records that name another live
process, a drain in progress, Windows hosts, and any other command line (a developer's own
server, another base directory, another user) stay foreign: attach-only, never replaced.
Records that do name the live PID and port but carry an identity in another format, such as a
Windows CommandLine written by hand after a manual restart, are repaired the same way, on Windows
too: under the replacement lock, when the process is exactly that archive serve for this user, the
canonical identity replaces the file (the old one stays as `identity.unverified`). Any other
mismatch is refused and the error names the identity file and the next step.

A reused forward is checked against the live descriptor's `serverVersion`. A server replaced on
the same port by another client, a self-update or a person no longer matches the attachment, so
the client reconnects and reads the live server again instead of reporting, or acting on, the
version it first attached to. A host that already runs the requested build drops any refresh
intent kept from its older server. Callers that only reuse a forward that still answers, as
agents do before every remote tool, never publish `preparing`.

Desktop and agent dispatch both leave the server running when they disconnect
(`leaveRemoteServerRunning`). Removing a saved connection also leaves the remote runtime running.
The explicit stop script signals a server only after its
`/.well-known/goat/activity` (with a 404 fallback to `/.well-known/t3/activity`) answers `idle` for that PID. `busy` or no answer leaves it running.
No client signals a server to replace it; see [Replacement](#replacement).

Protocol ranges decide compatibility. The descriptor advertises `protocol: {ssh, orchestration}`
as `{min, max}` ranges, and a client attaches when both overlap its own.
`compareRuntimeProtocols` in `packages/shared/src/sshRuntimeProtocol.ts` is the one comparator.
It answers `compatible`, `update-required`, `client-too-old` or `unknown`. The TypeScript
client and the launch script both use it, the script through `__ssh-helper compat` in
`apps/server/src/cli/sshHelper.ts`. A server that advertises only the two integers is a point
range. Only a server with neither (`unknown`) falls back to matching the exact release.
`serverVersion` is informational.

> Decision record: [ADR-0012](decisions/ADR-0012-shared-ssh-runtime.md)

### Replacement

A server is replaced only through its own drain. The descriptor of a server that can drain carries
`capabilities.drainRestart` and an `instanceId`, which is new for every start. A server without
them is attach-only: no client replaces or signals it. If such a server is compatible, the
client attaches. If it is incompatible, the launch fails and asks the user to stop it.

The launch script holds the host replacement lock and calls `__ssh-helper drain`. That helper
sends `POST /.well-known/goat/runtime/drain` with `expectedInstanceId` and the target version. The
server accepts it only from loopback, with the secret from `<userdata>/runtime-control.token`
(mode `0600`, new every start). A request that names another start gets `instance-changed`.

While it drains, `RuntimeAdmission` (`apps/server/src/runtimeAdmission.ts`) makes
`Orchestrator.dispatch` refuse new work with `ServerDrainingError`. That covers clients, MCP,
scheduled tasks and channels alike. Continuations, steering into running work, and interrupts
still pass.

Every client that subscribed to the lifecycle stream with `runtimeDrain: true` receives
`runtimeDrain` events. Older clients never opt in, so they never have to decode the event.

`RuntimeDrain` (`apps/server/src/runtimeDrain.ts`) waits until no admitted dispatch is in flight
and projections report `idle`, or until the grace window ends. The window is 60 s by default and
at most 300 s. What happens next depends on the user's confirmation:

- Unconfirmed, an expired window cancels the drain, and the server admits turns again. The client
  reports a `busy` pending replacement and retries later.
- With `confirmReplacement` (the request's `force`), the drain completes at the deadline.
- On completion the server answers `drained` and sends itself `SIGTERM`. Normal shutdown
  persists restart continuations, and the successor's startup recovery restores those threads.

An automatic refresh of an older compatible runtime normally drains only a server that answered
`idle`. Recovering an uncertain drain is the exception: the authenticated reconciliation can start
a new drain if the earlier one cancelled, closing admission for the grace period even on a busy server. An
incompatible runtime, which the client cannot use at all, drains for the full window.

After `drained`, the script runs `__ssh-helper supervise` under `nohup` so a dropped SSH
session cannot strand the host. The supervisor:

1. Waits for the old PID to exit, then backs up `statev2.sqlite` while it holds the userdata's
   `server-owner.lock`. If another server holds that lock, it starts nothing and fails.
2. Starts the new runner on the same port and requires a handshake: a descriptor with the target
   version, a new `instanceId`, and compatible ranges. The runner gets `GOAT_SSH_REPLACEMENT_ID`,
   so the new server records itself in the lock's owner log as this replacement.
3. On failure, stops only the child it started and restores the database and the previous
   `run-t3.sh`. Then it starts the previous version (rollback). The database is restored only
   when the owner log since the backup names nobody but the supervisor and its replacement, so
   another server's writes are never overwritten.

After a rollback to a compatible version, the client attaches to it.

> Decision record: [ADR-0013](decisions/ADR-0013-drain-replacement.md)

### Upgrades

A client that launches a host owns its runtime and moves it to its own release. The packaged
desktop and the server's SSH dispatch (`resolveSshCliRunner` in
`apps/server/src/sshRemote/SshRemoteDispatch.ts`) both set `refreshOwnedRuntimeOnFirstConnection`.

- With no server running, the client installs and starts its release, even when `run-t3.sh` names
  an older compatible release that is still installed. It keeps the retained release when that
  one is newer or cannot be ordered. If its exact archive cannot be acquired, recovery may select
  a newer compatible installed build, including one newer than the client, only with a proven
  build order within bounded discovery. Recorded installs must match their executable digest
  before any helper runs. Marker-only installs qualify when their own binary proves its exact
  version and both protocols; launch verifies the executable digest captured by the probe.
  The usable connection reports its actual version as ready (or providers_not_ready) with
  `refreshDeferred`, preserves provider diagnosis, and retries the requested release every
  10 minutes. `ssh.runtime.upgrade.skipped` logs the selected version and reason.
- A host with nothing installed, nothing running and no GOAT database gets the newest published
  runtime that is compatible with the client when the exact archive cannot be acquired
  (`publishedFallback`, set by the same two callers; `packages/ssh/src/runtimePublished.ts`).
  Release manifests (`packages/shared/src/runtimeManifest.ts`) prefilter by protocol and
  capability; the installed binary decides. See
  [Remote updates](../docs/internals/remote-updates.md) for the pre-manifest rule.
- With an older compatible server running, the first connection of each manager drains it once it
  answers `idle` (see [Replacement](#replacement)). While it is busy or cannot drain, the client
  attaches to the verified compatible runtime, logs `ssh.runtime.refresh.deferred` with the reason,
  and retries every 10 minutes. A drain deferral stays usable with `refreshDeferred`; retries ask
  for drain support again rather than retaining negative compatibility answers.

After a launch that installed a runtime, cleanup runs under the host replacement lock, never
on a drain/replacement or rollback connection, and excludes concurrent installs. It uses the
live binary's `__ssh-helper compare-version` to remove only proven older, unused directories,
keeping the live, retained and requested versions and one rollback build: the proven-older
build installed most recently, which is the one the host ran before. Versions whose order
against the live build is unknown, or that are newer, stay. It checks process commands,
executable paths and cwd (`/proc` on Linux, `lsof` on macOS), renames victims into sibling
`.trash-*` directories before deleting, and never follows symlinks. Each ordering check starts
`goat`, so a long backlog shrinks over several connections, oldest installs first, within the
cleanup deadline. Staging and trash directories over an hour old are removed too, since no
install holds a lock then. The mutex is `flock`, or an atomic directory where `flock` is
missing. Errors only log `ssh.runtime.cleanup.*`; a failed inspection keeps everything.
Windows is skipped because its process and shell utilities differ.

Runtime supply targets the owning process's exact release and platform, not the
latest published build. The acquisition order in
[`packages/ssh/src/tunnel.ts`](../packages/ssh/src/tunnel.ts) starts on the host: for a
published version with no mirror configured, the host downloads the release itself
(`hostDownload`, set by the desktop and the server's SSH dispatch). If the host's download
exits with an error, the client supplies the archive from its bundle, local cache, an explicit
mirror, the public release download, then the GitHub CLI, and uploads it. A lost connection or
a timeout fails the attempt instead, since the host may still be installing.
Public archives belong to `goat-si/goat-releases` and are checksum-checked. Enabling
release publication does not prove an archive exists: fresh-host verification needs
the matching published asset or an explicitly supplied mirror/cache archive.
A manually published nightly is evidence only for that exact version and platform.
Older cached archives are not selected automatically when no compatible installation exists:
archive integrity does not prove protocol support or authorize a userdata downgrade.

A runtime on a stable or nightly build also updates itself when idle, following its own channel
(see [Server: Updates](server.md#updates)). It runs the owning launch script locally, so it takes
the same replacement lock, idle check, drain and supervisor as a client. A new client passes
`GOAT_RUNTIME_DRAIN_AUTOMATIC=1` to `__ssh-helper drain` for an automatic refresh of an older
runtime, never for a manual or confirmed update or an incompatible runtime. The runtime answers
such a request `cancelled` without draining when its target is not the newest same-channel,
strictly newer, never-failed candidate, or while its `automaticServerUpdates` is off; the
client keeps its attachment. The supervisor
records every outcome in `last-replacement.json` next to `run-t3.sh`.

Manual updates target the owning manager's version too. An idle update waits for running work;
a confirmed immediate update allows the drain to finish at its deadline. A newer runtime, a
runtime whose version cannot be ordered, or a foreign server (see [Shared runtime](#shared-runtime)) blocks replacement
without changing whether a compatible server can be used.

"Older" and "newer" come from `compareRuntimeBuilds` in `packages/shared/src/semver.ts`, used by
both the client and the remote `__ssh-helper compare-version`. A different core version, or two
numbered builds of one train (`0.1.0-nightly.20261012.2`), order by SemVer. Any other pair of one
core, such as two `0.1.0-dev.<sha>` builds or a dev build against a nightly, orders by the commit
time each server build embeds (`apps/server/vite.config.ts` reads it from git, or from
`GOAT_BUILD_COMMIT_TIME`). The probe reads the installed builds' times with
`__ssh-helper commit-time`, and the client sends its own as `archiveCommitTime`. When either time
is missing, the pair has no order: a running server is kept (`ssh.runtime.upgrade.skipped` logs
why), and an incompatible one is refused and left running. There are two exceptions. On a stopped
host, a retained build with no commit time predates stamping, so a stamped client installs its own
release over it. Stopping a server from before commit stamps once therefore moves its host to the
client's build. And a build of unknown order whose CLI cannot issue memory scopes (the shell's
`lacks_memory_scopes` reads `auth session issue --help`) counts as older, with pending replacement
`capability`, because keeping it would fail every memory-granted task on that host. A newer build
is never replaced for this. The MCP-session script never drops requested memory scopes: a CLI that
cannot issue them makes it print `GOAT_SESSION_ERROR=memory_scopes_unsupported runtime=<version>`,
which the client reports as an `SshPairingError` naming the runtime.

Only the pairing and MCP-session helpers pass `keepExistingRunner`. It never installs, refreshes,
or replaces a runtime.

An archive upload pipes the bytes into ssh's stdin. If the remote reader exits early, only that
upload fails, as an `SshLaunchError` carrying the remote's stderr and exit code. A lost connection
or a timeout stays the `SshCommandError` that names the host. The patched
`@effect/platform-node-shared` spawner keeps an `error` listener on every child stdin, so a write
still queued when ssh exits cannot crash the process with `EPIPE`.

### Connect and disconnect order

`SshEnvironmentManager` orders `ensureEnvironment` and `disconnectEnvironment` calls for one
target by arrival. Both resolve the alias before they take the target lock, so a later call can
reach the lock first. A disconnect does nothing once a newer call for that target exists, and an
ensure ends neutrally once a newer disconnect exists. Compatible calls share one credential-free
manager preparation; pairing completes separately for each caller. Canceling a waiter detaches
its observers, while preparation lives in the manager scope. Disconnect invalidates the owner
before waiting for the target lock. Completion revalidates the generation, selected runtime and
live attachment; an attachment hint never authorizes use of a replacement runtime.

The client registry keeps one SSH teardown per route in flight (`forkSshDisconnect` in
`packages/client-runtime/src/connection/registry.ts`). Switching off again while it is stalled
marks it to run once more, and that rerun happens only if the route is still off when the first
one returns.

SSH runtime state and update results share the contract in
`packages/contracts/src/sshHost.ts`. `apps/server/src/sshRemote/SshHostSetup.ts` owns
host probe, trust, preparation, forget, status, and runtime updates for dispatch
aliases. It uses thin bridges in `apps/server/src/sshRemote/SshRemoteDispatch.ts`
to reach the existing server manager; it does not create another manager.
`apps/desktop/src/ssh/DesktopSshEnvironment.ts` owns saved desktop targets and runs
status, idle updates, and confirmed immediate updates through its existing manager
and typed IPC (`packages/contracts/src/ipc.ts`). Sparse request-scoped phase events replay the
current phase and remaining preparation budget to joining renderers; terminal readiness carries
native attachment evidence, not proof of an authenticated client session. Server and desktop
managers remain separate owners. Desktop catalog storage remains
client-owned: local native-primary setup reviews trust through the server but
installs through the desktop manager. Remote or WSL clients cannot use that local
ownership path.

Adding a host starts with one read-only preflight shared by Settings and agents:
`packages/ssh/src/preflight.ts` runs reachability, host key, key sign-in, platform,
runtime and disk checks with fresh SSH processes (no shared master, strict host keys,
no host-key updates), and `packages/ssh/src/runtimeAvailability.ts` checks the
runner's archive sources without downloading archives. The runtime check follows the same
published-fallback rule as provisioning: an opted-in runner with no mirror may use the newest
compatible published release only when the host has no installed runtime or GOAT data.
`SshHostSetup.preflight` serves it as `sshHost.preflight` with the server's own runner. `apps/server/src/sshRemote/SshDeviceAdd.ts`
is the one agent path behind `goat_ssh_host_add` and its alias `goat_connection_add_ssh`:
a failed check stops before any side effect, a new host key becomes a pin-only
approval, and a passing host is saved through the desktop catalog when one is attached
and registered in this server's [hub node list](#hub-nodes). Without a desktop the hub
list alone saves it; a host GOAT has not run on is first prepared on a managed alias.
`packages/shared/src/sshDestination.ts` parses typed
destinations for both.

SSH setup and immediate-update approvals resume through SshHostSetup's shared
continuation worker. `apps/server/src/handoffs/Handoffs.ts` retains the private
approved session and execution payload until the result is published and acknowledged;
`apps/server/src/handoffs/HandoffExpiry.ts` and
`apps/server/src/orchestration-v2/runtimeLayer.ts` wire expiry, startup recovery,
and response wake to that same worker. Execution rechecks the approving session's
target permissions. This is SSH-specific continuation, not general handoff wake.
Idle updates also run as server jobs: admission returns on the first actual phase
or terminal outcome rather than waiting through runtime installation.

The managers have separate status caches; the remote replacement lock and runtime
state coordinate updates across owners. Both retain the drain policy. Progress is
reported at TypeScript operation boundaries; the remote shell protocol carries no
progress events. Connections reads the desktop cache and keeps runtime status in
the saved connection row after transient notifications disappear. Status reads do
not install or start a stopped runtime, and snapshots last only for the manager's
lifetime. `apps/server/src/provider/ProviderDiagnosisRouting.ts` chooses local or
remote diagnosis; host diagnosis requires an already-ready runtime and otherwise
returns prepare/status recovery instructions without starting one. Agent setup
publishes runtime readiness before diagnosis, so clients keep checking the current
setup operation until diagnosis completes. Only that operation's result can finish
setup; an old provider summary cannot. The server manager retains this diagnosis
summary; the desktop connection row reads its own runtime cache. Thread cards use
authenticated handoff progress lookup, including after completion and remount,
without a desktop bridge.

### Host trust and forgetting

`packages/ssh/src/hostKey.ts` probes the effective OpenSSH target without
authenticating and reports the negotiated destination key. Human approval covers
that fingerprint and the first Include change. The shared writer in
`apps/server/src/cloudMachines/sshConfig.ts` keeps ordinary host entries and pins
under `~/.ssh/goat-hosts`, separate from Boat's `~/.ssh/goat-cloud`. Each use checks
that `ssh -G` still applies the pinned settings; a changed key stops the connection
rather than prompting automatic replacement. Existing keys and ssh-agent take
precedence over creating a GOAT key. Password-based key registration stays in a
person's terminal on the owning environment's machine.

Forget fences the alias's current operation before waiting for installation,
invalidates tunnels and sessions, then removes only GOAT-owned config and pins.
Optional idle stop requires an owned, idle runtime; busy, unknown, and external
runtimes stay running. Remote data, shared keys, and the Include line remain.
Removing a saved desktop connection does not perform this host cleanup.

The dispatch caller imports `@goat/ssh/command`, `@goat/ssh/auth`, `@goat/ssh/config`,
`@goat/ssh/errors`, and `@goat/ssh/tunnel`.
`apps/server/src/device/SshDeviceHost.ts` uses `@goat/ssh/command` for device commands.

## Agent dispatch

The [SSH toolkit](../apps/server/src/mcp/toolkits/ssh/tools.ts) exposes host setup,
status, updates, forget, browsing, and thread dispatch; callable capabilities and
human steps are defined in the [registry](../packages/contracts/src/agentSurface/registry.ts).
Browse uses `apps/server/src/sshRemote/remoteBrowse.ts`.
On a Git Bash, MSYS2, or Cygwin host the shell reports `/c/…` paths but GOAT there is native, so
browse returns `C:\…` paths (`cygpath -w` when present) and launch compares projects case- and
slash-insensitively; a Windows server also maps a received `/c/…` or `/cygdrive/c/…` root itself.
Launch goes through `SshRemoteDispatch.launchThread`. When the MCP caller is itself a thread, the
SSH toolkit asks `RemoteDispatchCoordinator` to persist the dispatch first. That coordinator is
[`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md).

Workspace sync for a remote checkout is `apps/server/src/sshRemote/SshWorkspaceSync.ts`. Remote
repo paths it prints sit under `$HOME/.goat/repos/`.

[`RepositoryInventory`](../apps/server/src/project/RepositoryInventory.ts) reads only registered
projects and their Git worktrees, with bounded snapshots exposed by host status on request.
[`RepositoryLaunchMcpService`](../apps/server/src/mcp/RepositoryLaunchMcpService.ts) checks an
explicit origin-key selection before SSH dispatch, preserving the caller's host-read ceiling.
These are local-ref diagnostics, not proof that work is pushed or a placement policy.

[`RepositoryReferences`](../apps/server/src/project/RepositoryReferences.ts) reads exact requested
regular blobs from a pinned commit without a fetch or working-tree mount. The MCP reference
service rechecks caller authority and remote content bounds, then copies snapshots into the
worker brief; no source credential or write capability travels with them. Ambient provider
filesystem permissions are unchanged. Runtime root grants must remain unsupported unless a
provider can enforce them. Raw nested reference arguments are validated before MCP's lenient
codec can discard unsupported authority fields.

## Linked hosts

A linked host is another GOAT server this environment reaches over HTTPS instead of SSH, such as
a headless `goat serve` behind Tailscale or a LAN address. `apps/server/src/linkedHosts/LinkedHosts.ts`
links one by spending a pairing code from that host through its MCP OAuth endpoints
(`/oauth/mcp/register`, `decision`, `token`), the same path an outside agent's sign-in takes, so the
host needs no change and issues an ordinary `mcp-client` session with the access chosen at link
time. Every link, token included, is one `linked-hosts` secret in `ServerSecretStore`.

`SshRemoteDispatch` checks a host name against the links before SSH: `callHostTool` and
`launchThread` use the link's origin and saved session, and `connectedHosts` includes every link,
so the thread, project, worktree, host-status and launch-watch paths reach it without their own
branch. SSH-only operations (browse, setup, runtime updates) refuse a linked name.

The trade against SSH is authority. An SSH session is issued per call at the caller's ceiling;
a link's session is fixed. `linkWriteRefusal` therefore refuses a write from a caller whose ceiling
is below the link's access, a link never answers approvals, and launch only uses a folder that is
already a project there: it cannot browse the host to apply the broad-folder guard, so a person on
that host chooses the workspace.

## Cloud machines

A Boat (boat.dev) machine becomes an ordinary OpenSSH alias, `boat-<sandbox id>`. The GOAT
server that created it owns everything about it: the Boat API key in `ServerSecretStore`, a
private catalog of owned sandbox ids in `cloud-machines.json` under the state directory, and the
SSH files. With the user's consent it puts one `Include ~/.ssh/goat-cloud/*.conf` line at the top
of `~/.ssh/config`, because OpenSSH keeps the first value it reads. Each machine gets its own
`.conf` and a pinned `.known_hosts` there; after every rewrite `ssh -G` must show the pinned
settings, or GOAT refuses to connect.

Boat moves a machine to a new address and host key on every resume, so
`apps/server/src/cloudMachines/CloudMachineService.ts` refreshes both through Boat's SSH-key call
before an SSH operation on an owned alias (`SshRemoteDispatch` calls it at browse, launch,
preflight, remote scripts and host tool calls) and drops that alias's tunnel and session caches
when either changed. Only explicit work wakes a stopped machine and extends its auto-stop time:
browse, launch, handoff and Resume. Host tool calls also serve launch watches, report polling and
host status, so they only refresh a running machine, and host listing never asks Boat at all.
The desktop connects only after the renderer asks the owning server for the same non-waking
refresh, and Electron refuses a `boat-` alias whose `.conf` is missing or stale.

The catalog keeps a machine until Boat confirms it is gone or the user forgets a stopped one, so
GOAT never loses track of a machine that may still bill. `BoatClient.ts` is the REST client;
`sshConfig.ts` writes the SSH files. Agents list, create, stop and resume machines through
`goat_cloud_machine_*` tools in the SSH toolkit; every change needs a reconfirmed
`settings:write` grant, as in Settings. Deleting a machine and managing the key stay in Settings.

> Decision record: [ADR-0008](decisions/ADR-0008-ssh-hosts.md)

## Hub nodes

The hub is the GOAT server a phone pairs with. `HubNodes` in
`apps/server/src/hubNodes/HubNodes.ts` owns the list of machines it reaches, so a headless
`goat serve` serves the same list to every client over `hub.nodes.*` (`WsHubNodesRpcGroup` in
`packages/contracts/src/rpc.ts`, wire shapes in `packages/contracts/src/hubNodes.ts`). Reading and
checking need `orchestration:read`; adding, removing, importing and dismissing need
`settings:write`. `goat_connection_*` MCP tools call the same service. Its tables live behind
`apps/server/src/hubNodes/HubNodeRepository.ts`.

A node is one GOAT environment with one or more routes. Routes come from three sources, merged by
`apps/server/src/hubNodes/merge.ts`:

- SSH hosts registered on the hub, in `hub_node_registrations`. An unregistered `~/.ssh/config`
  alias is not a node. Registering a `boat-` alias is refused because the cloud source owns it.
- Every `LinkedHosts` link. The route shows the link's access and expiry, never its token.
- Every machine in the `CloudMachineService` local catalog. Listing never asks Boat.

Routes with the same environment ID are one node. The ID comes from the link for linked hosts
and, for SSH and running cloud machines, from `SshRemoteDispatch.identifyTarget`, which reads
`environment-id` over SSH without starting a runtime, from the server this hub's connection to the
host uses. With no connection it is the [app server](#app-server)'s while that server could be
attached, otherwise `$HOME/.goat/userdata/environment-id`. A route whose ID is
unknown is its own node with ID `route:<routeId>` until a check learns it; `get` still resolves
that ID afterwards. The hub's own ID is refused at add and dropped at merge.

Check never wakes or extends a cloud machine. It asks Boat for state once per check and probes a
cloud route over SSH only when that state accepts SSH, through `ensureReady({ wake: false })`. A
stopped machine reads offline. Route status, last-seen time and learned IDs persist in
`hub_node_route_state`; a forgotten cloud alias loses its row. `changes` subscribes before it
reads the first snapshot and coalesces signals, so a slow client gets the latest list, not a
backlog, and a failed read waits for the next change instead of ending the stream.

Removing a node deletes registrations and unlinks links. Cloud routes are refused, and a node
with one is not partly removed. The desktop renderer imports its saved SSH connections once per
hub (`hub_node_imports`); a catalog that cannot be unlocked records a notice that clients show
until the user dismisses it or a later import succeeds. An agent's SSH add goes through
`SshDeviceAdd`, which reports the hub registration separately from `desktopCatalog`, so a
desktop save never hides a hub failure. An agent removal deletes the hub node and forwards it
to an attached desktop catalog, reporting `desktopCatalog` as `saved`, `not_attached` or `failed`.
