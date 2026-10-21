# Hub

A hub is one GOAT environment that runs your fleet. Its machine is also the
[OpenCodex Home](./providers-codex.md#use-opencodex-home) that holds every
provider sign-in, and your other machines reach their models through it. GOAT
shows whether each linked device really uses the hub, and holds cloud runs there.

The hub is off until you turn it on. Make only one environment the hub.

## Turn it on

Open **Settings → Hub** on the machine whose OpenCodex is the Home, and turn on
**This machine is the hub**. GOAT then checks every linked device every 30
minutes. Checking only reads: it never changes a device or its OpenCodex
settings. **Cloud runs** chooses whether Claude Cloud, Cursor Cloud and Devin
Cloud runs start on the hub or wherever a sign-in exists.

Devices join from OpenCodex (`ocx link add` on the Home) and show under
**Devices** after the next read. Accounts and keys stay in OpenCodex; open its
dashboard from **Accounts and keys**.

## Read a device

Each device shows how it joined (Remote Link Child, Hub client, or standalone),
its parity, its OpenCodex version, and the Home's tunnel to it. Parity is **ok**
when the hub serves the device's requests and its settings match, **degraded**
when traffic works but something on the device still describes the device,
**broken** when requests do not reach the hub, and **unproven** when the device
cannot say which Home served it. **Verify** checks one device now.

**Use this device's own sign-in when the hub is down** is off by default. With it
off, goal work on that device pauses while it cannot reach the hub. OpenCodex can
also forbid local fallback; until your OpenCodex reports that, its state reads
**unknown**.

Fleet shows the same devices in its **Hub** entry. Select its count to see each
one.
