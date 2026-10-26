# Remote access

Connect a phone, browser, or another desktop app to GOAT running on a different
machine. That machine must stay running and reachable while you work.

## GOAT Connect (coming soon)

GOAT Connect is coming soon. T3 Connect sign-in and managed tunnels are
unavailable. Connect your devices with direct pairing, [Tailscale HTTPS](#tailscale-https),
or [SSH](#desktop-managed-ssh).

`goat connect` and its subcommands print
"GOAT Connect is coming soon. Use `goat pair --tailscale` to connect a device over Tailscale."
and exit successfully without changing your connection settings.

Previously linked servers start normally and keep their stored link dormant.
Saved environments with only a T3 Connect route show as unavailable; add a
direct or Tailscale route, or forget the environment in connection settings.

## Connect your phone to a hub

A hub is the one GOAT server your phone pairs with, ideally a machine that stays
on. The phone and the hub must be on the same tailnet, so install Tailscale on
both and sign in to the same account.

On the hub's desktop app, open **Settings → Connections**. The **Connect your
phone** card at the top has the **Tailscale HTTPS** switch and **Show phone
QR**. Turn on Tailscale HTTPS first: without it, the QR dialog explains how to
turn it on, and only offers a tailnet or local network address after you choose
one. On a hub without the desktop app, run `goat serve --tailscale-serve`, then
`goat pair --tailscale` to print a QR code.

On the phone, open GOAT and tap **Scan QR code**, allow camera access the first
time, and point the camera at the hub's QR code. The app connects as soon as it
reads the code and opens the hub's sessions. To type an address and pairing code
instead, open **Advanced → Enter address manually**.

These QR codes are GOAT app links. Scan them from inside GOAT; scanning one with
the phone's camera app opens GOAT's scanner, and you scan once more there. QR
codes printed by older T3 Code versions still scan. Browsers use the
`Pairing URL` printed next to the QR code.

If pairing fails, the app shows three checks and stops at the first one that
failed:

1. **Tailscale** (or **Network** for a non-tailnet address): the phone could not
   reach the hub. Turn on Tailscale on the phone and sign in to the hub's
   tailnet, or check that the hub is awake.
2. **Hub responds**: something answered, but not as a GOAT hub this app can use.
   Check the address and update GOAT on the hub.
3. **Pairing code**: the hub rejected the code. Codes work once and expire; show
   a new QR code on the hub.

To switch to another hub, open **Settings → Environments → Change hub** on the
phone and scan the new hub's QR code. The old hub is removed from the phone
after the new one connects. To keep several servers on the phone, use
**Settings → Environments → Advanced → Add another server**.

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

Scan the QR code from the GOAT app on your phone, or paste the pairing URL into
**Add device → Tailscale (GOAT server)** on web and desktop. Connection settings are under **Settings → Connections**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.

### Reach one machine several ways

A machine can have more than one route: LAN, Tailscale, another VPN, a public
URL, or SSH. Tailscale shares its `100.64.0.0/10` address range with
other VPNs such as Cloudflare WARP, so an address in that range shows as VPN
unless the machine confirms it is on Tailscale. To add a route, choose **Add
route** in the machine's route list.
Pairing the same machine again over another address also adds a route instead
of a second machine. A new route is placed by speed, in that order, and you can
reorder routes at any time.

While connected through a paired address, GOAT also learns the
machine's current LAN and Tailscale addresses and adds them as routes. When the
machine's LAN address changes, for example after it joins another Wi-Fi network,
the learned route follows it. The machine must allow network access for its LAN
address to be learned. The [background service](./background-service.md#local-network-access)
allows it on private networks by default. You can reorder a learned route, but not remove it; it
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
choose **Edit**.

Open **Permissions** next to **Routes** in web or desktop, or **Your permissions**
in the mobile route details, to see what your current connection can do on that
environment. For a remote environment, this is in its route details. Permissions
shown there apply only to the route marked **In use**; other routes are not
checked.

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

Agents spread their own work too. When more than one machine is connected, an
agent checks each machine's load, providers, and sign-ins before starting
parallel or heavy work, starts each piece on a machine with room for it, and
keeps work that needs your browser or local files on the machine you are using.
It skips machines that are unreachable, cordoned, or need an update, and never
starts a Boat cloud machine unless you ask. Its final report says which machine
ran what.

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

### Connect a browser

Open the direct pairing URL in a browser that can reach the server. For a
secure address on your tailnet, use [Tailscale HTTPS](#tailscale-https).
On mobile, an IP address entered without a scheme uses HTTP, so include
`https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add device**, choose
**SSH**, and pick a host from your SSH config or type an address such as
`user@example.com`. GOAT starts or reuses a server there and opens the port
forward for you. Projects, provider credentials, and agent work stay on the
remote machine.

Before it installs anything, GOAT checks the host and shows one line per check:
whether it answers (including Tailscale), its host key, sign-in with your SSH key,
the operating system, free disk space, and whether a GOAT runtime is available for
that platform. On a host that has never run GOAT, the runtime check also considers
the newest compatible published release, using the same rule as installation.
A check that fails says what to change, often with a command to copy, and
**Check again** runs them again. **Connect** turns on once nothing is left to fix. A host GOAT has not seen before shows its fingerprint for you to
approve first. If you approved a host but its checks still fail, **Forget host** in the
same dialog removes the SSH entry and pinned key GOAT added. Agents run the same
checks and get the same results.

GOAT signs in only with SSH keys or your ssh-agent. If a host turns your key down
and would ask for a password, the sign-in check says so and offers an
`ssh-copy-id` command: run it once in a terminal on this computer, enter the
password there, then choose **Check again**. For a host from your SSH config, the
user, port and key come from that file; change them there.

The remote host must be Linux, an Apple Silicon Mac, or a Windows machine set up
as described below, with `tar`, `sha256sum` or `shasum`, and
`git` for project work. Set up provider CLIs and sign-in with
[provider sync](#providers-on-your-machines) or follow [provider setup](./install.md#providers)
on that host. GOAT keeps its server, launch state,
and data under `~/.goat`, apart from any T3 Code install in `~/.t3`. A fresh host
does not need the desktop app or Node.

A Windows host works when its OpenSSH server uses Git Bash as the default shell
(the OpenSSH `DefaultShell` setting pointing at Git for Windows' `bash.exe`).
GOAT starts its server outside your SSH session so it keeps running after you
disconnect, which means the server gets your Windows user environment rather
than the SSH session's: provider CLIs must be on your Windows `PATH`. After an
app update, a Windows host moves to the new version only from a GOAT release;
a server started from a source checkout must be stopped before reconnecting.

The first launch can take longer while GOAT installs its runtime. It uses a
bundled or cached archive when available. Otherwise it uses your configured
release mirror, or downloads the matching published GOAT release and checks its
checksums. If a public download fails, GOAT can try the GitHub CLI when signed in
(`gh auth login`). It refuses a checksum mismatch and names the expected release
when it cannot obtain an archive. Connections shows the current setup step. The first
installation can take a few minutes; reconnecting while it runs joins that setup.

When the host is asleep or off the network, its connection shows **Unreachable**
and GOAT keeps retrying, sooner when this computer wakes or joins a network.
Agent work on the host keeps running while you are away. A rejected SSH key, a
changed host key, or a runtime that refuses this app stops retrying until you
choose **Reconnect**; the connection's status says what to fix.

### Recovering a watched thread while its host is offline

Ask the launching agent to enable checkpoint copies for a remote watch with
`goat_call {path:"thread.watch", args:{host, threadId, checkpointReplication: "on"}}`. To set
the policy for an entire host, use
`goat_call {path:"thread.replication_set", args:{host, checkpointReplication: "on"}}`.
Turning the host setting `"off"` stops new copies for both channel tasks and ordinary
watches. Existing channel tasks keep their previous default when the setting is omitted;
ordinary watches require opt-in. Recovery is owned by the launching GOAT thread;
launcherless webhook watches keep their existing reporting behavior. These operations
require full access, and changing the
host policy also requires permission to write settings. Checkpoint replication and recovery are unavailable while goatclaw permission profiles are enabled; profile ceilings and lane accounting are not yet supported by these operations. Remote capture and recovery use only
an existing authorized connection; reconnect explicitly if its session is missing or expired.

Copies are taken after completed checkpoints, not continuously. The `thread.watch_list` and
`thread.status` paths show the latest copy and any skipped capture. To recover, ask the
launching agent to call `goat_call {path:"thread.handoff_host"}` with `fromReplicatedCheckpoint: true`, the
source `host` and `threadId`, the copy's run as `expectedRunId`, and a registered
`destinationProjectId`. Add `destinationHost` for another machine; omit it to recover here.
The destination must already be ready, identify the same repository, and use an enabled
provider that runs in its local worktree; cloud providers are not recovery destinations. The destination must also have the shared base commits; if they are missing, fetch them
there and request recovery again. Recovery does not fetch from or contact the source.
Automatic moves remain off.

Recovery starts a new thread in an isolated worktree with the copied unpushed commits and
uncommitted file contents. Staging selections are not preserved. It carries bounded
conversation context, not the provider's full session or attachments. Copies are limited to
8 MiB; snapshots containing excluded or oversized new files are skipped. Turning copying off
discards in-flight copies and keeps the last admitted copy. Recovery refuses copies older than
seven days. Older checkpoints without completeness evidence, nested repositories and submodules
are not eligible; complete another supported checkpoint before relying on recovery.

A refused destination can be corrected and requested again. A known successful recovery is
returned on retry even if that destination is now offline. Checkpoint contents expire
independently of the small recovery records, so an existing launch can still be reconciled.

The disconnected source may still perform external actions. GOAT fences its reports and
tries to interrupt only its recorded old run after reconnecting; this does not guarantee
that external side effects happened only once. Interruption waits while the launcher is in
plan mode or its authorized connection is unavailable. If recovery reports `launch_unknown`, retry
the same recovery to reconcile it rather than starting a separate launch. An empty destination
thread is not proof that its recovery run started.

On Linux and macOS hosts, provider CLIs must be on the `PATH` of a
non-interactive login shell there; check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

The machine that owns your SSH connection keeps the host's GOAT runtime at its
own version. The host does not need the desktop app. In **Settings → Connections**,
check the SSH connection's runtime status and choose **Update runtime** to retry an
update. A busy compatible runtime stays available while the update waits.

Choose **Update now** and confirm to update immediately. Running agent work gets up
to a minute to finish, then continues on the new version. **Cancel** leaves the
runtime running as before. Agents can request an update that runs when the
runtime is idle. If the new version fails to start, GOAT restores the previous one.

Runtime archives come from published GOAT releases or a configured release mirror.
If this app's own version has no archive (a development build, for example) and
the host has never run GOAT, GOAT installs the newest published runtime that works
with this app instead. The connection then shows **Running <version> · Upgrade to
<version> deferred** and GOAT retries the upgrade every 10 minutes. A host that
already has GOAT data never gets a different version this way. When nothing
usable exists, the status says so and names the one thing to do. GOAT does not
replace a newer runtime; update the machine that owns the SSH connection instead.

A server that GOAT cannot confirm it launched, or that cannot restart itself,
is left running. GOAT keeps using it if it is compatible; otherwise, stop it on
the host and reconnect. When two computers update the same host at once, the
second retries after the first finishes. If an interrupted update left the host
locked, the error names the file to remove after you check that no other GOAT
app is updating it. Removing the connection leaves GOAT's server running on the
host. Ask an agent to forget the host and stop its runtime when idle, or use
**Forget host**. GOAT stops only an idle server it owns; remote projects and files stay.

Each desktop app keeps one session on the host for its SSH connection and reuses
it when it reconnects. Revoke sessions you no longer use in **Settings →
Connections** on the host, or on a headless host with `goat auth session list` and
`goat auth session revoke <id>`. A desktop that can still sign in over SSH pairs
again on its next connect.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

### Providers on your machines

Open **Settings → Connections → Providers on your machines** to compare installed
provider versions and sign-in status on this machine and connected SSH hosts.
Choose **Sync to other hosts…** for a provider and select your destination
machines. GOAT uses the vendor's official npm package or installer for each
operating system, matching this machine's version by default, or installing the
latest if it is absent here. Cursor's installer always installs the latest.
Choose **Update runtime** for a host whose GOAT is too old, or **Prepare host**
if its runtime is stopped, then retry.

Each host installs and starts its own sign-in. Complete the offered device code
or vendor sign-in page, or finish in GOAT on that host. If a terminal step is
needed, run it on the destination: `claude auth login`, `agent login` (Cursor),
`grok login`, `opencode auth login`, or `pi` followed by `/login`. Codex uses
`codex login --device-auth`. An agent can request a sync; approve the request in
its thread before installation starts. Cancelling stops unfinished work; a
completed installation stays installed.

GOAT never copies credentials between machines. For headless Codex login,
[OpenAI documents copying `~/.codex/auth.json` as a fallback](https://developers.openai.com/codex/auth).
A person may do this between their own machines, treating the file like a
password; GOAT does not automate it.

Sync only to your own machines and sign in with your own account on each.
Never sign in to someone else's account or share yours.
[Claude's consumer terms](https://www.anthropic.com/legal/consumer-terms) forbid
sharing login credentials or letting others use your account; see also the
[Pro plan guidance](https://support.anthropic.com/en/articles/8325606-what-is-the-pro-plan).
[OpenAI accounts are for the individual](https://help.openai.com/en/articles/10471989),
and [use across your own devices is supported](https://help.openai.com/en/articles/8980438).
Cursor and xAI subscription policies: **needs confirmation**; no source has been
verified yet.

### A fresh VPS

Open **Settings → Connections → Add device → SSH**, or tell an agent to
“connect a new SSH host” and give it the address and SSH user. Check the displayed
host-key fingerprint against your server provider's record before approving.
The first approval also lets GOAT add its Include line to your SSH config. Approving
only pins the key; the checks run again before GOAT installs anything.

GOAT uses SSH keys or your ssh-agent. If it creates a key, register the displayed
public key with your server provider or add it to the host. If the host only
accepts a password, run the offered `ssh-copy-id` command in a terminal on the
machine that owns this GOAT environment, then retry. Your password stays in that
terminal; GOAT does not collect it or run `sudo` for you.

GOAT prepares the runtime before checking providers. Provider diagnosis needs a
ready runtime; if preparation is still running or failed, check the host's status
and finish or retry setup first. After agent setup, GOAT checks provider CLIs and
sign-in on the remote host. Use [provider sync](#providers-on-your-machines) or
run the offered installation and sign-in commands there; signing in on your own
computer does not sign in the VPS. The desktop
connection row reports runtime setup.

Save the prepared host in the desktop app to see its environment in the sidebar.
With web or mobile alone, approve setup in the requesting thread. The host is then
available to that environment's SSH tools; adding it does not create a separate
sidebar environment on those clients.

If the host key changes, GOAT stops connecting. Check why it changed before
trusting it again. If you rebuilt the server, forget the host and add it again.
Forgetting removes GOAT's managed SSH entry and pinned key. It keeps your shared
SSH keys and the host's projects and files, and stops a runtime only when GOAT owns
it and no work is running.

### Start a worktree on a saved SSH host

Before asking an agent to start work on another machine, it can check registered
checkouts with `goat_call {path:"host.status", args:{host, repositories:true}}`. The inventory includes
local Git state; ahead/behind does not fetch from the remote, and unknown dependency
freshness does not mean dependencies are installed. An agent can pass the inventory's
origin key as `repository: {key, candidateHosts}` to `ssh.thread_launch` to
refuse an unverified checkout and report matching candidates. This check does not
copy uncommitted work or prepare stopped hosts. Use the canonical checkout path from
the inventory; diagnosis does not browse aliases or wake candidate hosts.

To give a worker sibling source code without mounting the sibling checkout, add
`references: [{mode:"snapshot", repositoryKey:"example.com/team/sibling", files:["src/api.ts"]}]`
to `thread.launch` or `ssh.thread_launch`. The worker receives the requested
committed text, including local unpushed commits; dirty files are excluded. Use `checkout`
from the inventory when more than one checkout matches, and `revision` to pin a local
commit. For an SSH launch, an omitted source `host` means the selected host; `host:null`
means the caller's machine. The source must already be ready and support snapshots.

`repository.snapshot` previews the same read. Capturing source requires an existing
file-read grant or full-access caller authority, checked again before returning content.
Snapshots support up to eight files, 16 KiB per file, 32 KiB per repository and 64 KiB per
brief. Secret paths and credential-like assignments (including prefixed keys such as
`DB_PASSWORD` and `AWS_SECRET_ACCESS_KEY`, with quoted or unquoted values after `:` or `=`), symlinks, submodules, binary content
and partial clones are refused. This copies data only: it grants no source filesystem or
host credential, and does not restrict permissions a worker already had.

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
itself, a thread started while the GOAT app is open runs in the app's own server
and appears in the app like any other thread. Without the app, GOAT starts a
background server there, and the app lists its threads under **Headless server**
while that server is running. Each start
issues a 12-hour sign-in on that machine, listed with its other clients. A
machine running an older GOAT
only accepts approval-required threads in folders that are already projects
there.

An agent can also list, add, and remove the devices on this hub (see
[Hub devices](#hub-devices)), including on a headless
`goat serve` with no desktop app. Adding uses only SSH keys or ssh-agent, never a
password, and needs a host where GOAT has run before; prepare a new host first.
Adding a device that is already listed returns it. Adding and removing need a
full-access thread or a full-access outside agent. While the desktop app runs on
the same machine, the agent's change is also saved in its
**Settings → Connections**, so the device's threads show up in the sidebar.

Adding a host and saving its connection are one step for an agent: it runs the
same checks as **Add device → SSH**, asks you to approve a new fingerprint, and
saves the connection once the checks pass. A new fingerprint needs approval in a
GOAT thread; an outside agent can save an already-trusted host. Without a desktop
app on that machine, or from an agent without full access, it prepares the host
and tells you the connection was not saved.

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

### Link a GOAT server for agents without SSH

When the other machine already runs GOAT on its own, such as a headless server
kept up with `goat service install`, and this machine reaches it over
Tailscale or your LAN, agents can use it without SSH. On that
machine, create a pairing link that can only grant agent access:

```sh
goat pair --tailscale --scope orchestration:read --scope orchestration:operate
```

Leave out `--tailscale` when the server already listens on an address this
machine reaches. Give an agent here the printed pairing URL, for example "link
https://mini.tailnet.ts.net/pair#token=… as mini". The code works once and
expires after five minutes. From then on agents use `mini` as the host for
projects, threads, worktrees and host status, start threads there, and include
it when they list threads across machines.

A link can do at most what you allow when linking. It is Supervised by default;
read-only links cannot start or change threads. Agents start threads only in
folders that are already projects on that machine, so add the project there
first, for example from the GOAT app connected to it. An agent whose own permission
mode is lower than the link's cannot change anything through it. A link cannot
answer approval requests, and folder browsing and runtime updates still need SSH.

A link lasts 30 days; link again with a new code to renew it. Removing a link
forgets it here. To end it on the other machine at once, revoke **GOAT on …** in
that machine's **Settings → Connections**. To watch its threads yourself, add
the machine under **Settings → Connections** with a pairing URL from `goat pair`.

<a id="devices-on-this-hub"></a>

### Hub devices

The GOAT server your phone or browser pairs with keeps one list of the machines it
reaches: SSH hosts you add, GOAT servers you link, and its cloud machines. Every
client paired with that server sees the same list, and a device added on the
desktop appears on the phone right away. It works the same on a headless
`goat serve`.

Find it under **Settings → Hub → Hub devices** on desktop and web, for the
environment selected at the top of Settings, and under **Settings → Hub devices**
in the mobile app. Each device also shows whether it is linked to the hub's
[OpenCodex](./hub.md#add-repair-or-remove-a-device). Add an SSH
host by its alias from this machine's `~/.ssh/config`, or add another GOAT server
with a pairing URL from `goat pair`. A machine reached two ways, for example
over SSH and as a linked server, is one device with two routes.

**Check** asks each route whether it answers. It never starts or extends a cloud
machine: a stopped one shows as offline. Cloud machines are removed from
**Settings → Connections → [Cloud machines](#cloud-machines)**, not from this list. Removing a saved connection in the
desktop sidebar does not remove the device from the hub.

The first time the desktop app runs as a hub, it copies the SSH connections saved
in its **Settings → Connections** into this list. If those saved connections
can't be unlocked, nothing is copied and the list asks you to add your devices
again; **Saved on this desktop** offers the desktop's SSH connections that are
not on the hub yet.

### Reach every machine through one hub

Pair your phone, or any other client, with one GOAT server you keep running, such as a Mac
mini or a small VPS. That server is the hub. Every machine the hub lists as a node then shows
up on the phone with its own threads, and the phone reaches it through the hub. The phone never
needs SSH, Tailscale access to the node, or a pairing of its own with that machine.

1. On the hub, pair the phone with hub access: `goat pair --tailscale --hub-proxy`. A pairing
   made without `--hub-proxy` reaches only the hub itself; pair again to add it.
2. Add the machines to the hub's [device list](#hub-devices). An SSH host needs nothing
   more. If GOAT never ran on it, choose **Set up** once, so the hub installs GOAT there and
   learns which machine it is.
3. For a machine linked over HTTPS, choose **Allow phone access** and paste a pairing link
   created on that machine with `goat pair`. Links made for agents cannot open your threads.

Through the hub you can open a node's threads, watch them live, send follow-ups with images or
files, stop a running turn, answer approval requests, and start a new thread on any node in a
folder you pick there. Archiving, deleting and other changes to a thread, editing project
scripts, and creating a folder that does not exist yet stay with the machine's own GOAT. A
thread started in a new worktree runs that machine's own setup script. A machine that is off or
asleep stays in the list as **Unreachable**, with its threads as last seen and how old that copy
is, for example "last state 5 min ago". It reconnects on its own when the machine comes back.
Stopped cloud machines are never started by opening them.

The hub holds the keys and sessions for every node, so keep its disk encrypted and its screen
locked.

### Cloud machines

GOAT can create [Boat](https://boat.dev) cloud machines and use them like any other
SSH host. In **Settings → Connections → Cloud machines**, paste a Boat API key and agree
to one `Include ~/.ssh/goat-cloud/*.conf` line at the top of this computer's
`~/.ssh/config`. Create the key with Boat's `ci` preset (`boat api-key create goat
--preset ci`), which can create, resume and delete the machines it made and connect
over SSH. A `full-sandbox` key cannot create or resume machines. The key stays on the
GOAT server that owns the machines.

Create a machine with a name, a size and an auto-stop time. It appears as
`boat-<id>`, which you can open from **Connect**, pick as an SSH host for a thread, or
give an agent. Boat bills the machine while it runs:

- **Stop** saves its disk as a snapshot that Boat keeps for about 14 days.
- **Resume** starts it again, and billing with it. Browsing, launching a thread or
  continuing a thread on a stopped machine also resumes it. Listing hosts, checking host
  status and following a running thread never do.
- **Delete** removes the machine and its data from Boat permanently.

Each use you start pushes the auto-stop time out again, but work that keeps running on
its own does not, so choose an auto-stop time that covers it. Boat gives a resumed
machine a new address and host key; GOAT refreshes and pins both before it connects.
Removing the key keeps the machines listed, so you can still find ones that may be
billing. Machines belong to the GOAT server that created them; open them from that
server.

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
`sudo goat browser setup`, and keeps your `PATH` when Node is installed only
for your user. Where `goat` is not on your `PATH`, such as with only the
desktop app installed, it names the full path of the app's own `goat` instead. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries and system fonts with apt; pages that load without text
can mean the host has no fonts. It is safe to run again. Without `sudo`, it only
reports what it would change.

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
goat pair --scope orchestration:read --scope relay:read
```

The selected scopes replace the default permissions. The same option works with
`goat auth pairing create` and `goat auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens and issued
bearer sessions get every permission, including managing access.
A terminal or a full-access agent on the host can reach those as well, so a
client that should not manage access also needs to go without `terminal:operate`
and `orchestration:operate`.

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

Settings changes, provider management, environment maintenance, and access
management can each be granted separately. New pairings without `--scope` include all of them. Existing clients keep the
permissions they paired with and can stay connected after an update, but newly
separated features may require pairing again with the permissions they need.
Older clients may show controls that the server denies. Create a fresh pairing
link to change a client's permissions.

`filesystem:read` allows browsing host files, opening workspace files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
the workspace. These scopes control direct file access from the client.

Removing an environment from a device's connection settings only forgets it on
that device. It does not stop the server or delete its stored link.
Background-service [removal](./background-service.md#manage-the-service) is separate.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Connections** and switch off **Local
environment**. GOAT restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through direct pairing, Tailscale, or SSH.

Switch **Local environment** back on in the same place to restart with your previous local
settings.

When another GOAT reaches this Mac over SSH while the app is open, it uses the app's own server, so
its threads and yours are in one place. When the app is closed, it starts a background server here
(`goat serve` on your `~/.goat` data), and the desktop app lists it as **Headless server**. Once
you open the app again, other GOATs move to the app's server as soon as the background server has
no running work; the background server itself keeps running, and its earlier threads stay under
**Headless server**. To hide it, switch off **Headless server on this Mac** in **Settings →
Connections**. To stop it starting at all, remove this Mac from the other GOAT's SSH hosts.
