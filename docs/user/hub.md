# Hub

A hub is one GOAT environment that runs your fleet. It is the GOAT server your
phone [pairs with](./remote-access.md#connect-your-phone-to-a-hub), and its
machine is also the [OpenCodex Home](./providers-codex.md#use-opencodex-home)
that holds every provider sign-in, so your other machines reach their models
through it. GOAT shows whether each linked device really uses the hub, and holds
cloud runs there.

The hub is off until you turn it on. Make only one environment the hub.

Hub settings live in three places. **Settings → Hub** turns the hub on and lists
its **OpenCodex devices**. **Settings → Connections** pairs your phone and lists
**Devices on this hub**, the machines the hub reaches for phones and agents.
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

## Add, repair, or remove a device

In **Settings → Hub → OpenCodex devices**, **Add device to hub** joins a machine
by its SSH alias; a standalone device in
the list has **Join** too. The device needs OpenCodex and a direct SSH alias on
the hub. GOAT compares the host key OpenCodex is offered with the key GOAT pinned
for that alias, links the device, and checks its parity.

A Windows device cannot be a Remote Link Child, so **Join** connects it as a Hub
client instead. That needs this hub's OpenCodex in Hub mode with addresses the
device can reach, such as behind Tailscale Serve. GOAT creates a single-use
invite on the hub and redeems it on the device; you never see or copy the code.
Agents can request the same for a device GOAT reaches only by password.

A cloud machine this hub creates joins by itself. The first time it is used,
GOAT installs this hub's OpenCodex release there with npm, starts it, and
links it as a Remote Link Child, using the host key it pinned when it created
the machine. It does this once per machine; use **Repair** if the link breaks
later. Machines you add over SSH are never joined automatically. The machine's
`goat_host_status` entry shows the progress, or why it stopped, for example
when the machine has no npm.

**Repair** walks the fixes for failing checks in order: sync the device's
settings, restart its OpenCodex once nothing runs there, and reconnect the link.
**Leave** disconnects the device and returns it to its own sign-ins, then revokes
its link or Hub key on the hub; GOAT asks before it does that.

## Sync OpenCodex models

**Sync OpenCodex** loads OpenCodex's current models into Codex, on the hub first
and then on each linked Child. Find it in **Settings → Hub → OpenCodex models**,
next to **Hub** on the Fleet page, and under **Update → Runtimes**. The dialog
shows what each machine will do, then its progress and result.

A Child always takes the hub's models and settings, never its own providers, so
GOAT syncs it only while it is linked to this hub; a Child that is not linked is
skipped with a pointer to **Repair**. Codex restarts to pick up the models only
on a machine with nothing running. On a busy hub the models are written now and
Codex restarts later; a busy Child is skipped until you sync again. GOAT also
syncs each machine right after a managed OpenCodex update moves it.

Each action lists its steps and their results. Some changes wait for a person: a
host key GOAT has not pinned or that changed, re-linking a device, or removing
one that could not be cleaned up. They appear in **Settings → Decision Inbox**;
answer there, then select **Continue** on the device. Approving needs permission
to change this hub's settings.

## Permission profiles

**Permission profiles** is off by default, and when you turn it on an agent
without its own profile gets the widest built-in profile, **owner**, until you
pick a narrower **Default profile**. With it on, GOAT refuses an agent's
request to launch or steer threads, work on other machines, manage the fleet or
change settings when its profile does not allow it. Pull requests are opened and merged from the
agent's own terminal, which profiles do not control; GOAT only refuses to start a
merge manager for an agent whose profile cannot merge. Turn it on in
**Settings → Hub**.

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
