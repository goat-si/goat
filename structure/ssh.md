# SSH

SSH is how one environment reaches a project on another machine. The local process does not mount
the remote disk. It either runs a remote shell for a browse, or it starts GOAT on that host and
talks to the remote server's own `/mcp`.

The [state roots](settings-and-storage.md#state-roots) contract is what the remote process uses
once it is up: `$HOME/.goat`, not the local default.

## Package

`packages/ssh` (`@t3tools/ssh`) has no root export. `packages/ssh/package.json` exports `./auth`,
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

The desktop app is a second caller of the same package. `apps/desktop/src/ssh/DesktopSshEnvironment.ts`
discovers hosts and ensures an environment. The server-side caller used by agents is
`apps/server/src/sshRemote/SshRemoteDispatch.ts`, which imports `@t3tools/ssh/command`,
`@t3tools/ssh/auth`, `@t3tools/ssh/config`, `@t3tools/ssh/errors`, and `@t3tools/ssh/tunnel`.
`apps/server/src/device/SshDeviceHost.ts` uses `@t3tools/ssh/command` for device commands.

## Agent dispatch

`apps/server/src/mcp/toolkits/ssh/tools.ts` registers `goat_ssh_host_list`, `goat_ssh_browse`,
`goat_ssh_thread_launch`, and `goat_ssh_reports`. Browse uses `apps/server/src/sshRemote/remoteBrowse.ts`.
Launch goes through `SshRemoteDispatch.launchThread`. When the MCP caller is itself a thread, the
SSH toolkit asks `RemoteDispatchCoordinator` to persist the dispatch first. That coordinator is
[`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md).

Workspace sync for a remote checkout is `apps/server/src/sshRemote/SshWorkspaceSync.ts`. Remote
repo paths it prints sit under `$HOME/.goat/repos/`.

> Decision record: [ADR-0008](decisions/ADR-0008-ssh-hosts.md)
