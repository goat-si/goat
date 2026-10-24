# Updating GOAT

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, an update notice appears in the
conversation and **Settings → Connections**. Update the machine named in that
notice.

## Update everything at once

The update button sits above Settings in the icon bar on the left edge of the
window; in narrow windows it is at the bottom of the sidebar. Hover it to see
how many updates each tab holds. Click it to choose what to update in two tabs:

- **App & servers** lists every connected GOAT server that is behind this app,
  the GOAT runtimes this desktop started over SSH, and this app itself. Servers
  move to the version your desktop app is installing, or to your web app's
  version. A background service stays on its current release channel, and a
  remote desktop app installs the latest release from its own channel.
- **Runtimes** lists provider CLIs, such as Claude and Codex, on each machine,
  and on a Hub the managed OpenCodex update.

Each row has a checkbox, and **Update** runs the checked rows of the tab you are
on. Machines GOAT cannot update are listed under **Skipped** with the reason,
such as a machine that is offline or needs a manual update. Use the notice or
**Settings → Connections** for those. Server updates appear only after that
version's CLI archives and checksums are available in GOAT Releases; desktop apps
use their own release feed.

For an [npm tarball installation](./install.md#install-with-npm), update the
launcher by reinstalling the target release's `goat-npm.tgz` from
https://github.com/goat-si/goat-releases/releases. Use the same npm prefix as the
original install: `npm --prefix <prefix> install --global <release-tarball-URL>`.
The npm launcher remains pinned until that reinstall; `goat update` does not
rewrite npm-owned files. For the latest stable tarball with your default prefix:

```bash
npm install --global https://github.com/goat-si/goat-releases/releases/latest/download/goat-npm.tgz
```

Updates never interrupt running threads. A machine with running threads shows
**waits for idle** and starts once they finish. Remote machines go first, and
this app restarts last, after its own threads finish and a short countdown. Choose
**Later** to restart from the update button when you are ready, **Restart now**
to restart without waiting, or **Stop waiting** to drop the machines still
waiting from this run.

While it runs, the button widens to show progress. It names a machine that is
taking longer than usual, and offers **Retry** for a server that failed. Click
it to see every machine. A server still restarting finishes on its own, and the
button keeps showing it after the desktop app restarts.

Managed OpenCodex updates run on their own on a Hub, Home first and then each
Child, while their machines are idle, and sync each machine's models into Codex
right after it moves. **Update** on the Runtimes tab asks for that check now; a
release that is still rolling out waits its turn. **Sync OpenCodex** below it
syncs models without updating.

If a desktop app restarts on its old version, GOAT tells you the update did
not apply. It does not install that version again on its own, even when another
device asks. Use the update button on that machine to retry.

## Before you update

Server updates restart the connection. An update started from **Settings →
Connections** or an update notice does not wait for idle, so it can interrupt
active agents and terminal commands. Saved threads, settings, and project files
remain.

**Settings → General → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
GOAT must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
A thread that finished its turn to wait on a monitor, subagent, or background task
is woken and told that this work stopped. A background shell, such as a dev server,
does not wake it; the thread learns about it with your next message.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three automatic resumes in a row,
the thread waits for your next message.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older GOAT versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update
  GOAT on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

Update the side the notice names, then reconnect.

For an SSH connection, **Update runtime** in **Settings → Connections** matches the
host to the version of the machine that owns that connection. It does not install a
newer release than that machine runs. Check the connection there for its runtime
version, progress, and any update waiting for running work. Updating this app also
moves its SSH hosts' runtimes after it restarts. The matching runtime archive must
be available from a published GOAT release or a configured release mirror.

An agent can request an update when the runtime is idle, then check its status
while work continues. To update immediately, approve **Update now** in the
requesting thread or in the owning desktop app. Running work gets up to a minute
to finish before the restart; cancelling leaves the runtime running. Removing a
saved connection also leaves it running. To remove GOAT's managed host entry and
stop an idle runtime GOAT owns, use **Forget host**; remote projects and files stay.

## Desktop app updates

GOAT (Nightly) downloads each new nightly by itself, and GOAT downloads each
new stable release. Once an update is downloaded, the app restarts to install
it when every local server reports that no agent work is running, or installs it
when you quit the app. If the app cannot check for updates, the update button next
to Settings shows a warning with the reason; click it to check again.

Choose the behaviour in **Settings → General → Update installation**:

- **Restart when idle** (default) installs as soon as all local servers are idle,
  or when you quit the app.
- **Install on quit** waits until you quit the app.
- **Paused** stops automatic downloads and installs; you can still update from
  the version row.

A server running inside WSL cannot report whether it is idle yet, so while one
is running, **Restart when idle** installs only when you quit the app or install
from the version row. Remote runtimes the app started over
SSH move to the app's version the next time they are idle; until then the
connection notice says the runtime will be replaced when its work finishes.

## Update a connected server

Background services automatically update within their stable or nightly release
channel when idle. This is on by default; turn it off in **Settings → General →
Automatic server updates** for the selected environments. Preview and development
builds do not update automatically.

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Run the command on the named host to update the detected global npm install, then restart the server with your usual options.                                                                   |
| **Copy relaunch command**  | Stop the command-line server on its host and relaunch with the copied command, keeping your usual subcommand and options. This does not update an installed `goat` command.                     |

On the host, run:

```sh
goat update <client-version>
```

Replace `<client-version>` with the version shown in the notice. The command
asks before restarting the background service; if you decline, run
`goat service restart` when you are ready. For a server you started by hand,
stop it and start it again afterwards with your usual options such as `--host`
or `--tailscale-serve`.

If `goat` is not installed on the host, [install GOAT](./install.md) from its
release archive first. Then run `goat update <client-version>` and restart
with the same subcommand and options.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

Only one server can use a GOAT home directory at a time. If startup reports that
another server owns it, stop that server before retrying, or use a separate home
directory and pair with the running server.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. Providers that only
offer a manual update command are not included.

After a successful provider CLI update, GOAT refreshes model discovery for
every enabled instance of that provider using its own configuration. Connected
clients receive the refreshed catalogs automatically. Provider update checks
must be enabled to download the latest GOAT model catalog.

Provider updates do not restart running chats. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the provider
status and refresh it again.

## Mobile updates

To update an environment from your phone, open **Settings → Environments** and
select it. **Check for updates** finds the latest release on that environment's
current release channel. Keep the app open while the environment updates and
reconnects. Hosts that cannot update remotely show instructions for updating on
the machine instead.

The same page lets you refresh provider status and update supported providers.
These controls require a connected environment and permission to operate it.
Provider update checks and restart continuation preferences are in
**Settings → Maintenance**. If provider update checks are disabled, enable them
there before refreshing to find newer versions. The same setting controls whether
GOAT downloads model catalog updates, so with it off new models may not appear
until you enable it and refresh provider status.

GOAT's mobile app has no App Store or Google Play release yet; TestFlight
installs new TestFlight builds. The mobile app can also download updates in the
background and apply them when you next leave the app.
It saves drafts and queued messages before restarting. If you keep the app open
for a long time, it may ask to install immediately; choosing **Later** leaves the
update queued for the next suitable moment.
