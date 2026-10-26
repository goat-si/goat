# Running GOAT in the background

On Linux and macOS, GOAT can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Install the `goat` CLI first ([Install GOAT](./install.md#command-line)), then
run these commands on the machine that will host GOAT:

| Task                            | Command                           |
| ------------------------------- | --------------------------------- |
| Install and start               | `goat service install`            |
| Install without restarting      | `goat service install --no-start` |
| Inspect status and log location | `goat service status`             |
| Move to a newer release         | `goat update`                     |
| Restart                         | `goat service restart`            |
| Stop and remove from startup    | `goat service uninstall`          |

Uninstalling the service leaves your projects, threads, and settings intact.
Running `goat service install` again repairs a service that `goat service status`
reports as broken.

Earlier releases installed the service as `t3code.service` on Linux and
`com.t3tools.t3code.service` on macOS. The next `goat service install`,
`goat service restart`, or `goat update` that restarts the service moves it to
`goat.service` or `si.goat.service`; until then `goat service status` reports
it as needing repair. A service that serves a different data directory,
including one still named `t3code.service` or an upstream T3 Code install, is
left alone. One user has a single `goat.service`, so installing for a second
data directory does not replace the first.

`goat update` downloads the newest release on your channel and switches `goat`
and the service to it. Restarting interrupts running agent turns, terminals,
and remote clients, so it asks first; answer no and the service keeps running
the old version until you run `goat service restart`. Pass `--yes` from a
script. A server you started by hand is left running; stop and start it again
to pick up the new version. Wait for any remote update already in progress
before updating; to match a remote client's version, follow
[Updating GOAT](./updating.md).

Pass an exact version (`goat update 0.0.42`) to pin one, `--channel nightly` to
switch trains, or `--allow-downgrade` to move backwards. `preview` is a
maintainers' test train: its builds can be broken and are never offered as
updates, so the installer and `goat update` ask for confirmation before
installing one.

`goat uninstall` removes the background service, the `goat` launcher, and the
downloaded versions after showing you the list and asking once. Your projects,
threads, and settings under `~/.goat/userdata` are kept, along with `service.env`
under GOAT home. Pass `--yes` from a script.

## Local network access

The service listens on your local network and Tailscale addresses, so the
desktop and mobile apps on the same network connect directly instead of through
GOAT Connect. The hosted web app at app.t3.codes stays on GOAT Connect, because
browsers block plain HTTP from an HTTPS page. The service does not answer on
public addresses, and every device still needs to pair or sign in. To keep the service reachable from this machine only, set
`GOAT_HOST=127.0.0.1` in `service.env` (below). Any `GOAT_HOST` value
replaces this default.

## Configure the service environment

Put custom environment variables in `service.env` under the service's GOAT home
directory, normally `~/.goat/service.env`. This file survives service installation
and updates. For example:

```dotenv
GOAT_PORT=3773
GOAT_HOST=127.0.0.1
```

Use `KEY=VALUE` entries, quoting values that contain spaces or `#`. Values are
literal: shell commands and variable expansion are not evaluated. Entries
override the inherited service environment, except for `PATH`, `GOAT_HOME`,
`GOAT_BOOT_SERVICE_UNIT`, and `GOAT_SERVICE_LAUNCHER_CONTEXT` (including case variants).

Run `goat service restart` after changing the file. Changes apply when the service
starts again; switching the server version alone keeps the current values.
For a service installed before env-file support, run `goat service install` once
with an up-to-date CLI.
A missing file is ignored; other read failures stop service startup.
If the file contains credentials, restrict access to that file with `chmod 600`
(for the default GOAT home, `chmod 600 ~/.goat/service.env`).

## Platform support

Linux needs systemd user services. Setup enables lingering so GOAT starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

The background service runs independently of GOAT Connect. Previously linked
servers keep starting normally; connect with [direct pairing or Tailscale](./remote-access.md#tailscale-https).

## Troubleshooting

Start with `goat service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running GOAT as root creates a separate installation. Without
administrator access, run `goat serve` in a terminal and keep that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status goat.service`, then use the repair command printed by GOAT.                          |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `goat service restart`.                          |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the `goat` executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/si.goat.service.plist`.

For connecting another device to a running server, see
[remote access](./remote-access.md).

## Reclaim database space

GOAT removes superseded internal history on its own while it runs; your
conversations are kept. Databases created before this shrank automatically
still hold the freed space on disk until a one-time offline repair returns it
and turns on automatic shrinking. Settings > Storage (web and desktop) or
Settings > Maintenance (mobile) suggests the repair when at least 1 GiB can be
reclaimed.

Run `goat doctor` on the machine that hosts the environment. It reports the
database size and the space it can reclaim, then asks which repairs to run;
pass `--fix` to run the recommended ones without a prompt (for scripts), or
`--dry-run` to only report. An installed background service for the same data
directory is stopped for the repair and started again afterwards, also when
the repair fails. Quit a server you started by hand, or the desktop app, first:
the repair refuses to touch a database that is in use. Use `--base-dir` for a
different data directory.

The repair can take several minutes on a large database. It rebuilds the
database through a temporary copy, so it needs free space of about the
database's size twice over: once in the system temporary directory (`TMPDIR`
or `/tmp` on Linux and macOS) and once next to the database for its
write-ahead log.

If you upgraded from a version before 0.1.0, its database (`state.sqlite`) is
still kept next to the current one so you can roll back. `goat doctor` offers to
delete it, but never selects that repair for you and `--fix` skips it: once it
is gone, a version before 0.1.0 starts with no threads or settings.
