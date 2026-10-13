# SSH

SSH is how one environment reaches a project on another machine. The local process does not mount
the remote disk. It either runs a remote shell for a browse, or it starts GOAT on that host and
talks to the remote server's own `/mcp`.

The [state roots](settings-and-storage.md#state-roots) contract is what the remote process uses
once it is up: `$HOME/.goat`, not the local default.

## Package

`packages/ssh` (`@goat/ssh`) has no root export. `packages/ssh/package.json` exports `./auth`,
`./command`, `./config`, `./errors`, and `./tunnel`.

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

### Shared runtime

One host user runs one SSH-managed server, and every client shares it. The launch, pairing, MCP
session, stop, and log scripts keep their ownership records (`pid`, `port`, `managed`, `identity`,
`run-t3.sh`, `server.log`) in `~/.goat/ssh-launch/runtime` (`REMOTE_RUNTIME_STATE_KEY` in
`packages/ssh/src/command.ts`), whatever alias, hostname, or port the client dialled. A client that
finds a compatible live server attaches to it, so threads started from any client live in that
server's state and every client sees them.

The live `~/.goat/userdata/server-runtime.json` record and the server's descriptor decide identity.
Remembered launch files whose PID has exited are stale and do not block attaching
(`readLiveSshRuntimeProtocol` in `apps/server/src/cli/sshHelper.ts`). They never grant kill
authority either, because the launch script requires its PID file to name the live PID.

Desktop and agent dispatch both leave the server running when they disconnect
(`leaveRemoteServerRunning`). The explicit stop script signals a server only after its
`/.well-known/t3/activity` answers `idle` for that PID. `busy` or no answer leaves it running.
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

An automatic refresh of an older compatible runtime drains only a server that answered `idle`, so
its retries never hold up new turns. An incompatible runtime, which the client cannot use at all,
drains for the full window.

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

The desktop app is a second caller of the same package. `apps/desktop/src/ssh/DesktopSshEnvironment.ts`
discovers hosts and ensures an environment. The server-side caller used by agents is
`apps/server/src/sshRemote/SshRemoteDispatch.ts`, which imports `@goat/ssh/command`,
`@goat/ssh/auth`, `@goat/ssh/config`, `@goat/ssh/errors`, and `@goat/ssh/tunnel`.
`apps/server/src/device/SshDeviceHost.ts` uses `@goat/ssh/command` for device commands.

## Agent dispatch

`apps/server/src/mcp/toolkits/ssh/tools.ts` registers `goat_ssh_host_list`, `goat_ssh_browse`,
`goat_ssh_thread_launch`, and `goat_ssh_reports`. Browse uses `apps/server/src/sshRemote/remoteBrowse.ts`.
Launch goes through `SshRemoteDispatch.launchThread`. When the MCP caller is itself a thread, the
SSH toolkit asks `RemoteDispatchCoordinator` to persist the dispatch first. That coordinator is
[`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md).

Workspace sync for a remote checkout is `apps/server/src/sshRemote/SshWorkspaceSync.ts`. Remote
repo paths it prints sit under `$HOME/.goat/repos/`.

> Decision record: [ADR-0008](decisions/ADR-0008-ssh-hosts.md)
