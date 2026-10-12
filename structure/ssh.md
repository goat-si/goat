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
(`leaveRemoteServerRunning`). The stop script and the replacement path signal a server only after
its `/.well-known/t3/activity` answers `idle` for that PID. `busy` or no answer leaves it
running. A startup refresh replaces a
compatible runtime only when it is older on the same release train: `0.1.0-dev.*` and
`0.1.0-nightly.*` have no meaningful SemVer order, so the client attaches instead
(`releasesOrderable` in `packages/ssh/src/tunnel.ts`).

> Decision record: [ADR-0012](decisions/ADR-0012-shared-ssh-runtime.md)

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
