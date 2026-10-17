# Remote access

Connect a phone, browser, or another desktop app to GOAT running on a different
machine. That machine must stay running and reachable while you work.

## T3 Connect

T3 Connect makes an environment available to your other devices without setting
up router forwarding. In the desktop app on the host, open **Settings →
Connections**, sign in, and enable **T3 Connect** for that environment.

For a command-line host, run:

```bash
goat connect
```

Follow the sign-in instructions. Setup offers a
[background service](./background-service.md); if you decline it, start the
server with `goat serve`. Saving your sign-in alone does not make the machine
reachable.

On your other device, sign in to the same T3 Connect account and choose the
environment. Over SSH, the CLI prints a browser link and a short code. Open the
link on any device, confirm the code matches, and approve. The CLI continues on
its own, so you do not need to forward an OAuth callback port.

T3 Connect renews access credentials when needed without disconnecting a healthy
connection. Pull request diffs and provider settings keep working after the
previous credential expires. A failed renewal affects that request; it does not
disconnect an otherwise healthy conversation.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Connections**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
goat serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
goat pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **Settings → Connections**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.

### Reach one machine several ways

A machine can have more than one route: LAN, Tailscale, another VPN, a public
URL, SSH, or T3 Connect. Tailscale shares its `100.64.0.0/10` address range with
other VPNs such as Cloudflare WARP, so an address in that range shows as VPN
unless the machine confirms it is on Tailscale. To add a route, choose **Add
route** in the machine's route list, or next to it in the T3 Connect list.
Pairing the same machine again over another address also adds a route instead
of a second machine. A new route is placed by speed, in that order, and you can
reorder routes at any time.

While connected through T3 Connect or a paired address, GOAT also learns the
machine's current LAN and Tailscale addresses and adds them as routes, so
pairing once through T3 Connect is enough to use the LAN at home. When the
machine's LAN address changes, for example after it joins another Wi-Fi network,
the learned route follows it. The machine must allow network access for its LAN
address to be learned. You can reorder a learned route, but not remove it; it
goes away with the route it was learned through, or when the machine stops
reporting that address.

GOAT connects over the first route that answers. Away from home, a LAN
address that does not answer is checked briefly and skipped. It is only tried
again, after the other routes, if none of them connect. While connected over a
later route, GOAT checks the earlier ones when your network changes, when you
return to the app, and every minute, and moves back as soon as one works.

On web and desktop, select the route count under the machine's name in
**Settings → Connections** to see its routes. Drag a route to change the order,
or remove it. On mobile, open the machine under **Settings → Environments** and
choose **Edit**. Signing out of T3 Connect removes only that route; a machine
you can still reach another way stays saved.

Open **Permissions** next to **Routes** in web or desktop, or **Your permissions**
in the mobile route details, to see what your current connection can do on that
environment. For a remote environment, this is in its route details. Permissions
shown there apply only to the route marked **In use**; other routes are not
checked. Direct pairing and T3 Connect have separate sessions and may grant
different permissions.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Connections → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **Settings → Connections**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
goat serve --tailscale-serve
```

For an already-running server:

```bash
goat pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `goat pair --help` for other pairing options.

### Hosted web app

[app.t3.codes](https://app.t3.codes) needs an HTTPS endpoint. It connects directly
to your server; a hosted pairing link does not make an unreachable backend
reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. GOAT starts
or reuses a server there and opens the port forward for you. Projects, provider
credentials, and agent work stay on the remote machine.

The remote host must be Linux, an Apple Silicon Mac, or a Windows machine set up
as described below, with `tar`, `sha256sum` or `shasum`, and
[provider setup](./install.md#providers). GOAT keeps its
server, launch state, and data on the host under `~/.goat`, apart from any T3
Code install in `~/.t3`.

A Windows host works when its OpenSSH server uses Git Bash as the default shell
(the OpenSSH `DefaultShell` setting pointing at Git for Windows' `bash.exe`).
GOAT starts its server outside your SSH session so it keeps running after you
disconnect, which means the server gets your Windows user environment rather
than the SSH session's: provider CLIs must be on your Windows `PATH`. After an
app update, a Windows host moves to the new version only from a GOAT release;
a server started from a source checkout must be stopped before reconnecting.

The first launch uploads GOAT's server from this computer, so it takes longer
than later ones. When this computer does not already have the server for your
GOAT version, it downloads it from the public GOAT releases and checks it
against the published checksums. If that release is not published yet or the
download fails on the network, GOAT tries the GitHub CLI when it is signed in
(`gh auth login`). A download that does not match the published checksums is
refused. If neither source works, the connection fails with an error that names
the release it looked for.
On Linux and macOS hosts, provider CLIs must be on the `PATH` of a
non-interactive login shell there; check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

After an app update, GOAT moves the host's server to the app's version. The
server stops taking new messages and gives running agent work up to a minute to
finish. Every app connected to it shows that it is restarting. It then restarts
on the new version, and any work it interrupted continues there. If work is still
running after that minute, the server keeps going as before, the connection
says it will be replaced when its current work finishes, and GOAT retries in the
background. If the old server still works with the app, GOAT keeps using it and
only starts this once it is idle. If the new version fails to start, GOAT puts
the previous one back.

A server from a GOAT release that cannot restart itself this way is never
replaced. GOAT keeps using it if it works with the app; otherwise the error asks
you to stop it on the host and reconnect. GOAT never replaces a server that is
newer than the app; update the app instead. If GOAT cannot confirm that it
launched a server, it leaves it running and the error names the process to stop
before you reconnect. When two computers update the same host at once, the
second retries after the first finishes. If an interrupted update left the host
locked, the error names the file to remove after you check that no other GOAT
app is updating it. Removing the connection stops a server that GOAT launched; a
server that was already running is left alone.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

### Start a worktree on a saved SSH host

In the desktop app, save the host in **Settings → Connections**, then open a new
thread in a project on this device. In the workspace menu, choose **Worktree on SSH**
and the saved host. Send your message to start the thread there.

GOAT copies the project's commits and current tracked and untracked changes into
`~/.goat/repos` on that host, then creates a new worktree. Untracked files that Git
ignores (such as `.env`) stay behind; files already committed travel with the history.
Provider credentials stay on their machines, and the thread belongs to the
remote environment. Use SSH keys or an ssh-agent; password prompts are unsupported.
The new worktree's setup script follows that host's own project script settings; if the
host has no setup script configured, install dependencies there yourself.

The secret-file check is an early warning for common newly added credential filenames.
It does not scan tracked files or commit history. Keep secrets out of the project
before copying it. If a launch response is lost, the thread may already have started;
check that host's threads before sending again.

To bring committed work home, open the remote thread and choose **Fetch branch to
this device** in **Git actions**, or search for it in the command palette. The result
shows a local ref you can inspect in the original repository. See
[Fetch a branch from an SSH worktree](./source-control.md#fetch-a-branch-from-an-ssh-worktree).

To move a thread you already started, choose **Continue on SSH host…** in the thread's
menu or the command palette, pick the saved host, and optionally say what to do next.
GOAT copies the thread's worktree the same way, including uncommitted changes, starts a
new thread on that host with a summary of the conversation, and leaves a note in the
original thread pointing to it. Wait for the current turn to finish first; a running
thread cannot be moved. Your local worktree is left as it was, so you can keep working
here or fetch the remote branch back later.

SSH worktree creation and fetch-back are available in the desktop app. The remote
thread can also be followed through an existing web or mobile connection.

### Let an agent start work on another machine

An agent can also start a thread on another computer over SSH. Ask it, for
example, to "run this in ~/work/api on mini". It lists the hosts in this
machine's `~/.ssh/config` and `known_hosts`, browses folders and Git worktrees on
the one you name, and starts a thread there in that folder or in a new worktree.
The folder becomes a project on that machine, and the thread runs in that
machine's own GOAT, which is started the same way as above if needed.
An agent can also move a thread there, uncommitted changes included, when you ask
it to "continue this on mini"; it does so as the last step of its turn.

Only SSH keys or a running ssh-agent are used; a host that asks for a password
is refused. Starting a thread needs a full-access thread or a full-access
outside agent. To watch the new thread, add the same host under
**Settings → Connections**, or ask the agent to add it for you. On that machine
itself, the GOAT desktop app lists these threads under **Headless server** while
that server is running. Each start
issues a 12-hour sign-in on that machine, listed with its other clients. A
machine running an older GOAT
only accepts approval-required threads in folders that are already projects
there.

An agent can also list, add, and remove the connections saved in
**Settings → Connections**, so another machine's threads show up in the
sidebar without a trip to Settings. This works while the desktop app is open on
the machine the agent runs on; web and mobile clients keep their own saved
connections. Adding uses only SSH keys or ssh-agent, never a password, and
adding a host that is already saved returns the saved one. Adding and removing
need a full-access thread or a full-access outside agent. Settings shows the
change right away, and the agent's connection list shows which agent added each
connection.

The agent that started the thread can follow it from here: it waits for the
thread to finish, reads its messages and the result its agent recorded (outcome,
pull requests, tests, and commits), sends it follow-ups, or stops it, and it
can list threads across this machine and the ones it is connected to. The
remote thread cannot report back on its own, so ask the starting agent to wait
on it. Sending to or stopping a thread on another machine needs an agent in the
default interaction mode, and that machine still refuses threads that run with
broader permissions than the agent has.

**Settings → Connections → Remote launches** lists the threads each connected
environment started or watches on other machines, grouped by SSH host, even
when this app runs on a different computer from the one that started them. A
thread opens from there once this app is also connected to its machine. In the
desktop app, **Connect** adds the host over SSH using the same host name. A
thread started from another machine shows **Launched by** with that machine's
name in its header, also when the launching thread is not open here.

## Browser on a remote environment

Browser tabs belong to the environment, so you and your agents see the same
tabs from any device. The desktop app shows its own environment's tabs
directly. Every other device, and the desktop app for other environments,
streams them from the host. Agents keep using them while no device is
connected, and `localhost` addresses reach servers on the host.

The first tab downloads a headless Chrome, about 120 MB, into the GOAT home. It
is the same browser [HTML renders](html-renders.md) use, so a host downloads it
only once. Some Linux hosts need [setup](#browser-host-setup) before it can
start.

Agent tabs have separate storage and share a Chromium process. Take control before
typing into an agent's tab, then release control when you want the agent to
continue. Read-only connections can watch without changing the page.

While you have control, the tab works with your device: text the page copies or
cuts goes to your clipboard, a file picker on the page opens your device's
picker, and a finished download is offered for you to save. Popups such as
sign-in windows open as their own tabs. Downloads stay on the host until the
tab closes. Audio does not play on your device.

On a phone, tap the floating preview's corner dot to show its controls, then
**Pop into separate window** to keep watching in picture-in-picture over other
apps.

### Browser host setup

macOS, Windows, and Linux desktops run the browser as is. Some Linux hosts need
one-time setup: Ubuntu 23.10 and later block the sandbox the browser runs in,
and minimal images and containers lack libraries it loads. When that happens,
the server says so at startup, and browser tabs and HTML previews show the
command to run on the host:

```sh
sudo goat browser setup
```

The server shows the exact line for how you started it, such as
`sudo npx t3 browser setup`, and keeps your `PATH` when Node is installed only
for your user. Where `goat` is not on your `PATH`, such as with only the
desktop app installed, it names the full path of the app's own `goat` instead. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries with apt. It is safe to run again. Without `sudo`, it
only reports what it would change.

The browser always runs in Chrome's sandbox. Where you cannot change the host,
set `GOAT_SERVER_BROWSER_SANDBOX=0` for the environment to run without it.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents GOAT did not start can drive
threads on an environment through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `goat auth --help`.

A session with an open connection stays listed after its access credential
expires.

To choose a token's permissions, pass `--scope` once for each scope you want:

```sh
npx t3 pair --scope orchestration:read --scope relay:read
```

The selected scopes replace the default permissions. The same option works with
`npx t3 auth pairing create` and `npx t3 auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens retain
standard client permissions and issued bearer sessions retain administrative
permissions.

To change an existing client's permissions, create a fresh pairing link with the
scopes it needs. In a browser opened directly on the environment, open that link
to replace the browser's current grant. For mobile or a saved remote environment
in web or desktop, use **Add Environment** with the fresh link or code; pairing
the same environment replaces its saved grant. Reconnecting alone does not change
permissions.

Grouping checkouts does not combine their permissions. Shared project settings
require `orchestration:operate` on every member environment; actions on one
checkout use that checkout's permissions.

`source-control:write` covers direct Git and pull request changes made from the
client: pushing, switching or creating branches, cloning, and removing
worktrees. It does not restrict what a task does. Starting a task in a new
worktree still creates that branch and worktree with `orchestration:operate`,
and the agent it runs can use Git however the environment allows.

Settings changes, provider management, and environment maintenance can be granted
separately from access administration. New standard pairings include these
permissions. Existing clients can stay connected after an update, but newly separated
features may require pairing again with the permissions they need. Older clients
may show controls that the server denies. Create a fresh pairing link to change
a client's permissions.

`filesystem:read` allows browsing host files, opening workspace files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
the workspace. These scopes control direct file access from the client.

To remove an environment from T3 Connect, open your account menu's **T3 Connect**
page, or **Settings → T3 Connect** on mobile, and choose **Deregister**. This
revokes its cloud access and frees its host space even when the environment is
offline or has been wiped. When T3 Connect rejects a host's link, the host
shows that it was removed from T3 Connect. To link it again, turn on
**T3 Connect** in **Settings → Connections** on a desktop host, or run
`goat connect link` on a command-line host and then restart GOAT there. A
command-line host that released its tunnel when it last stopped may link itself
again on its next start; run `goat connect unlink` on that host to keep it off.
Removing an environment from a device's connection settings only forgets it on
that device; it stays registered to your account.

When idle tunnel cleanup is enabled, T3 Connect removes a linked environment's
tunnel after it stays offline for several minutes. The environment stays linked
and keeps the same address. When the host starts again or wakes, T3 Connect
creates a replacement tunnel on its own. You do not need to pair again. Cleanup
usually runs five to ten minutes after the tunnel goes down.

T3 Connect also removes the tunnel of an environment running an older version of
GOAT once it has been offline for seven days. That environment shows a message
asking you to update. Start GOAT on that computer and update it to the latest
version; it reconnects at the same address without pairing again.

On a command-line host, `goat connect unlink` disables exposure while retaining
your login; `goat connect logout` also clears that login. Background-service
[removal](./background-service.md#manage-the-service) is separate.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## T3 Connect troubleshooting

Run `goat connect status` on the host to inspect saved authorization and link
configuration. It is not a live reachability check. If the environment appears
offline, run `goat service status` and read the displayed log. If it disappears
when SSH closes, see [background-service troubleshooting](./background-service.md#troubleshooting).

| Error                                                     | Recovery                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Deregister an unused environment, then restart GOAT on the host.                                                                                  |
| `auth_invalid` or `invalid_bearer`                        | Run `goat connect login`. If credentials were revoked, run `goat connect logout`, then `goat connect` again. Restart the server after signing in. |
| Expired or invalid link proof                             | Check the host's date and time, update GOAT, then restart it.                                                                                     |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                                     |
| HTTP 408, 429, or 5xx                                     | Check network and relay availability. Startup retries temporary failures for up to ten minutes.                                                   |

After fixing a permanent rejection, restart the host's server. On Linux, use
`systemctl --user restart goat.service` for the background service. For a
foreground server, stop it and run `goat serve` again with your usual options.
Include the diagnostic message and trace ID when reporting a persistent failure.

For a connection that still fails after linking, check the date and time on both
devices. For server version warnings, follow [Updating GOAT](./updating.md).

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Connections** and switch off **Local
environment**. GOAT restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through pairing, T3 Connect, or SSH.

Switch **Local environment** back on in the same place to restart with your previous local
settings.
