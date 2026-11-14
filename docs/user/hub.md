# Hub

A hub is one GOAT environment that runs your fleet. It is the GOAT server your
phone [pairs with](./remote-access.md#connect-your-phone-to-a-hub), and its
machine is also the [OpenCodex Home](./providers-codex.md#use-opencodex-home)
that holds every provider sign-in, so your other machines reach their models
through it. GOAT shows whether each linked device really uses the hub, and holds
cloud runs there.

The hub is off until you turn it on. Make only one environment the hub.

Hub settings live in three places. **Settings → Hub** turns the hub on and lists
**Hub devices**: the machines the hub reaches for phones and agents, each with
whether it is linked to the hub's OpenCodex. It shows the environment you select
at the top of Settings. **Settings → Connections** pairs your phone.
**Settings → Providers → Codex** chooses whether Codex uses OpenCodex Home.

When the desktop app first finds OpenCodex on its machine, it asks once whether
Codex there should use your OpenCodex Home or keep its own sign-in, and, on a
Home or a machine not yet linked to one, whether to turn on the hub and
permission profiles. It asks one question per launch, and closing a question
leaves everything as it was. Change these answers later in **Settings →
Providers → Codex** and **Settings → Hub**.

## Turn it on

Open **Settings → Hub** on the machine whose OpenCodex is the Home, and turn on
**This machine is the hub**. GOAT then checks every linked device every 30
minutes. Checking only reads: it never changes a device or its OpenCodex
settings. **Cloud runs** chooses whether Claude Cloud, Cursor Cloud and Devin
Cloud runs start on the hub or wherever a sign-in exists.

Accounts and keys stay in OpenCodex; open its dashboard from **Accounts and keys**.

GOAT Connect is coming soon. Its account-wide standing consent and sign-out/sign-in workflow
are described in [Reach every machine through one hub](./remote-access.md#reach-every-machine-through-one-hub).

## Add, repair, or remove a device

In **Settings → Hub → Hub devices**, **Add device to hub** joins a machine to the
hub's OpenCodex by its SSH alias; a standalone device in
the list has **Join** too. The device needs OpenCodex and a direct SSH alias on
the hub, such as a Tailscale alias or a [Pen](./pen.md#use-a-member-as-an-opencodex-child) `pen-<name>` alias. On a fresh Linux or macOS machine, the
[server installer's `--opencodex` option](./install.md#a-server-only-machine)
installs both; installing does not join the hub. GOAT compares the host key
OpenCodex is offered with the key GOAT pinned for that alias, links the device,
and checks its parity.

A Windows device joins as a Hub client until your GOAT includes an OpenCodex
release with Windows Remote Link support. A Hub client needs this hub's
OpenCodex in Hub mode with addresses the device can reach, such as behind
Tailscale Serve. GOAT creates a single-use invite on the hub and GOAT on the
device redeems it; you never see or copy the code. Agents can request the same
for a device GOAT reaches only by password. With Windows Remote Link support,
Windows x64 machines join as Remote Link Children over OpenSSH and Windows
PowerShell, without Git Bash. PowerShell there must run in Full Language mode;
setup stops and says so otherwise.

A cloud machine this hub creates joins by itself while **Join new cloud
machines** in **Settings → Hub** is on, as it is unless you turn it off. GOAT
installs an OpenCodex release it has tested there, without Node or npm, or keeps
a supported one that is already installed. It starts OpenCodex, links it as a
Remote Link Child using the host key it pinned when it created the machine,
installs Codex, and adds a Codex instance that uses the hub's accounts without a
sign-in on that machine. Use **Repair** if the link breaks later. Turning the
switch off stops new joins, even one already being set up; machines that are
linked stay linked.

An SSH host you added joins only when you turn on **Join as OpenCodex Child
after each SSH setup** on its row in **Hub devices**, on desktop, web or the
mobile app. GOAT then sets it up right away and again after each successful
SSH setup of that host, and links it only with the host key GOAT pinned when
you added it. The switch is your standing permission, so only a session that
can change settings turns it on; agents cannot. It turns itself off when you
forget or add the host again, and when the session that turned it on signs
out, expires, or loses settings permission; the row then says so. Turning it
off never removes the host from the hub: use **Leave** for that.

The hub and a Child can run different OpenCodex versions; a Child needs 2.66.0
or later. Provider accounts stay on the hub, and every Child shares its quota.
Fleet shows a Child's quota under the hub's pool. A host that does not report
which of its instances use the pool, such as one on an older GOAT, is matched
by provider and marked **inferred**; update GOAT there to see its actual routing.

A linked Child is **Ready** only after one small model request from its Codex
instance succeeds through the hub, and that request counts against the hub's
quota. Until then, its row in **Hub devices**, in the mobile app, and in Fleet
shows the step setup reached or why it stopped, with what to do next. For
example, a Child whose OpenCodex release cannot prove it holds no sign-ins of
its own asks you to update OpenCodex there. Agents read the same from its
`goat_host_status` entry. Checking status never sends a model request.
Changing the Child's Codex instance, its settings, or its link to the hub
clears **Ready** until setup verifies it again. GOAT retries setup after each
successful SSH setup of the host. **Continue setup** on the device's row, or an
agent with `goat_hub_device_setup`, retries or finishes it, including on a
Child linked before setup existed.
Claude Code, OpenCode, and Pi use the hub only when you route them there; see
[OpenCodex Home](./providers-codex.md#use-opencodex-home).

**Repair** walks the fixes for failing checks in order: sync the device's
settings, restart its OpenCodex once nothing runs there, and reconnect the link.
**Leave** disconnects the device and returns it to its own sign-ins, then revokes
its link or Hub key on the hub; GOAT asks before it does that.
To move a Child to another SSH alias of the same machine, such as its
`pen-<name>` alias, ask an agent to move it (`goat_hub_device_move`): you approve
once, for both aliases, the machine, the old link and the new host key, and GOAT
leaves the old alias and links the new one. If the new link fails, the same
approval finishes the move later. Aliases that name different machines are refused.

**Routes** on a Remote Link Child's row, in the web and desktop apps, lists the
SSH aliases the hub tries for its link, in order, and marks the pinned one. Add
another alias of the same machine, such as a LAN or Tailscale alias ahead of its
`pen-<name>` alias, to keep its traffic off the Pen relay: the hub stores a new
route only after it proves that machine's pinned host key over it. Move a route
up or down, or remove one; the pinned alias stays. A link created with one
exclusive route keeps that route and cannot be edited, and a Child that opened
its own link to the hub has no routes to change. When you cannot answer hub
decisions yourself, a change waits in the decision inbox; continue it from the
row once it is approved, until the page reloads. If the hub does not answer
within 2 minutes, the change may still finish there, so open the routes again
before you retry. Agents use `goat_hub_device_routes_update`, and a profile
other than owner asks you first. Routes need an OpenCodex release with link
routes on the hub; an older one says so.

## Disposable machines

A disposable machine is one you build for a short job, such as a cloud VM, and
admit to your Pen mesh with a one-time invite. The hub must run on macOS or
Linux. Turn on **Attach disposable
machines** in **Settings → Hub** (the hub must be on), then name the threads that
may attach machines by their thread ID (**Copy → Thread ID** in a thread's menu).
Only a person can change this consent, and it lasts 30 days: when it ends,
**Renew for 30 days** opens it again. Changing the threads, the cap or the name
rule cancels invites that were not used yet.

To attach a machine yourself, choose **Attach a machine**, paste the line
`pen identity --json` prints on that machine, and name it. GOAT shows the invite
token once, with this hub's machine key. Add the key to `authorized_keys` of the
machine's SSH user, then run `pen join` with the token on that machine within
10 minutes. While it
waits, **Reissue** cancels that invite and makes a new one for the same keys;
once it has expired, attach the machine again. A provisioner
thread does the same with `goat_hub_machine_attach`; its invite token appears in
that thread's tool output and history, so treat the thread as holding a secret
until the invite is used or expires.

Once the machine joins, the hub checks the route Pen recorded for it, reaches
it with the machine key alone, and links it to OpenCodex as a lightweight Child
on that route only. The machine list says where each machine is and what to do
next. On web and desktop, a machine GOAT cannot reach yet shows the machine key
with **Copy machine key**; on mobile its text says where to find the key. The link
needs OpenCodex 2.100.3 or later on the hub, the first release that can use the
machine key; with an older one the machine waits at the link step. OpenCodex
also refuses the key while a folder on its path can be written by its group or
others or belongs to another user. GOAT removes group and other write by itself
only from its state folder, the machine key's folder and its default home
folder, when they are yours; a home you chose with `GOAT_HOME` or
`--base-dir`, and every folder above it, it only names. The machine list says
what to do: `chmod go-w` only for a folder of yours, otherwise moving GOAT's
home to a path whose folders pass. Never change a shared or system folder or
another user's folder or symlink, even as root.

GOAT does not move its home for you, so when the list names a folder of yours,
the `chmod go-w` it shows is the simpler fix. To move the home anyway, stop GOAT,
move the folder, and start GOAT with `GOAT_HOME=<new>` or `--base-dir <new>`;
the database, secrets and hub records move with it. Some things keep the old
path: threads whose worktrees are in its `worktrees` folder still point there,
so finish them first; a background service keeps serving the old home until you
run `goat service uninstall --base-dir <old>` and then
`goat service install --base-dir <new>`; and the desktop app's `goat` command
needs **Remove** and **Install** again in **Settings → General → About**.
A linked disposable machine's OpenCodex link also keeps the machine key's old
path and stops working, so do not move the home while a disposable machine is
linked.

A machine with a full OpenCodex install, or one that shares its SSH host key
with another disposable machine, stops for you to decide.

Each machine is a full Pen member and can reach services on your machines'
loopback. GOAT does not detach it yet, and it stays a Pen member until you remove
it with [`pen revoke`](pen.md#remove-a-machine). Removing a linked machine from Pen leaves its
link on the hub; the machine list names the link and the `ocx link revoke`
command that removes it. An older GOAT on the
hub shows **Update GOAT on this hub** instead of these settings.

## Sync OpenCodex models

**Sync OpenCodex** loads OpenCodex's current models into Codex, on the hub first
and then on each linked Child. Find it in **Settings → Hub → OpenCodex models**,
next to **Hub** on the Fleet page, and under **Update → Runtimes**. The dialog
shows what each machine will do, then its progress and result.

A Child always takes the hub's models and settings, never its own providers, so
GOAT syncs it only while it is linked to this hub; a Child that is not linked is
skipped with a pointer to **Repair**. Codex restarts to pick up the models only
on a machine with nothing running. On a busy hub the models are written, but
Codex keeps its old list until it restarts or you sync again once the work
finishes; a busy Child is skipped until you sync again. GOAT also syncs each
machine right after an OpenCodex update moves it. Adopted installs are updated when their
OpenCodex supports orchestrated updates and otherwise receive advice; a stuck update window clears
once the member is back on its previous version, reinstalled with its own installer.

Each action lists its steps and their results. Some changes wait for a person: a
host key GOAT has not pinned or that changed, re-linking a device, or removing
one that could not be cleaned up. They appear in **Settings → Decision Inbox**;
answer there, then select **Continue** on the device. Approving needs permission
to change this hub's settings. An approval covers its change until that change
succeeds once or the approval expires a day later, so a step that fails without
changing anything can be tried again without asking you twice.

## Permission profiles

**Permission profiles** is off by default, and when you turn it on an agent
without its own profile gets the widest built-in profile, **owner**, until you
pick a narrower **Default profile**. With it on, GOAT refuses an agent's
request to launch or steer threads, work on other machines, manage the fleet or
change settings when its profile does not allow it. Agents allowed to create
worktrees, such as those under **worker** and **manager**, can also add and clone
projects; changing or deleting a project still needs permission to change settings.
An agent needs `pr.merge` to use GOAT's pull request merge and close tools. A
supervisor can start a merge manager only when its own grant allows merging;
otherwise, it asks a person through the decision inbox. Profiles do not control an
agent's own terminal: an agent with repository credentials can still open or merge
a pull request from there. Turn permission profiles on in **Settings → Hub**.

A profile's lane limit (`maxLanes`) also covers the subagents a coding agent
starts by itself. Codex and Claude run no more of them at once than the limit;
Claude Code older than 2.1.217 cannot count them, so GOAT keeps them off there.
Cursor, OpenCode and Pi can only turn them off, which GOAT does when the limit is 0. Grok, Antigravity, Fx and Muse cannot be limited. A changed limit applies from
the agent's next message; subagents already running keep going.

The switch covers your whole fleet. Turning it on or off on one machine does the
same on every host connected to it, and the most recent change wins wherever you
made it. The row lists each host as **applied**, **waiting** (not reached yet) or
**needs a GOAT update**; a host on an older GOAT cannot take the setting, and
agents cannot launch new threads on it while profiles are on. Follow-up messages
to threads already running there are still delivered, as they are to a host that
is still **waiting**, so your agents can keep steering their work. The agent is told
each time its limits may not apply on that host yet.

## Read a device

Each device shows how it joined (Remote Link Child, Hub client, or standalone),
its parity, its OpenCodex version, and the Home's tunnel to it. Parity is **ok**
when the hub serves the device's requests and its settings match, **degraded**
when traffic works but something on the device still describes the device,
**broken** when requests do not reach the hub, and **unproven** when the device
cannot say which Home served it. **Verify** checks one device now.

**Use this device's own sign-in when the hub is down** is off by default. With it
off, goal work on that device pauses while it cannot reach the hub. The setting is
stored on the device, so it works while the hub is down; to change it, GOAT needs
a connection to that device. OpenCodex must allow it too: the row says whether it
does, or **unknown** when your OpenCodex does not report it yet.

Fleet shows the same devices in its **Hub** entry. Select its count to see each
one.

A Remote Link Child's row also shows what its link to the hub carried: bytes
to and from the hub in the last hour and the last 24 hours, the share that went
through a Pen relay, the SSH alias the link uses (**via relay** for a Pen alias,
**direct** otherwise), and whether it runs over HTTP or a WebSocket. Select the
machine on the Fleet page to see the same line. GOAT counts from its own second
reading of the hub's OpenCodex, so traffic before that does not show, and a short
measurement says how long it covers. Bytes whose route GOAT could not confirm
are shown apart from relay and direct ones. A row says **not measured** when the
hub's OpenCodex does not report a number yet.

GOAT keeps these counts in memory, so they start over when GOAT restarts on the
hub, and the hub-wide warning covers only what it counted since then. GOAT reads
the numbers only while someone has Hub or Fleet open or an agent reads host
status: bytes across a longer gap are spread evenly over it, and the row says
**averaged**. A row says the figures are a lower bound when some requests to the
hub carried no length, and for 24 hours after a link WebSocket was open, since
WebSocket traffic is not counted.

GOAT warns in Hub and Fleet when one Child sends more than 5 GB through the relay
in 24 hours, or all of them together more than 30 GB. Change both, or set 0 to
turn a warning off, in **Settings → Hub → Relay traffic warning** on the web or
desktop app, or ask an agent to change them. A warning never stops a turn or a
link.
