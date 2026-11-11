# Pen

Pen is a GOAT-only mesh: a Go node (`apps/pen`), its wire contract and vectors
(`packages/pen-protocol`), a Cloudflare relay (`infra/pen-relay`), a Go relay (`pen relay serve`, run in
Seoul) and a Google sign-in service (`infra/pen-login`). The [contract](../../packages/pen-protocol/CONTRACT.md)
wins over the code; user workflows are in [Pen](../user/pen.md) and procedures in the
[runbook](../operations/pen.md). This page keeps the decisions and the traps.

## Trust

- **Members trust each other fully.** After the Noise handshake a member dials `127.0.0.1:<port>` for any
  port the peer names (`serveTCP` in `apps/pen/internal/daemon/accept.go`). There is no per-port or
  per-member policy, because a policy would need signed records every member enforces alike and Pen is
  one person's machines. Anything that listens on loopback of a member is reachable by every other member.
- **Relays are untrusted for content, trusted for availability.** They forward Noise records between
  pinned static keys and cannot read, forge, replay or splice them. They see node ids, client addresses,
  record sizes and timing. Close codes are not authenticated, so a hostile relay can end a dial (4401, 4400) or drop it; several relays are the answer to that, not code.
- **The installer trusts the relay that serves it.** `install.sh` checks the binaries against
  `SHA256SUMS` from the same relay (`apps/pen/install/install.sh`), which proves an intact transfer only.
  Whoever controls the download relay can ship any binary. Publishing checksums somewhere the relay
  operator cannot write (signed release assets) would remove that; it is not done.
- **The login service holds no mesh key.** It asserts only "node key `signPub` belongs to Google account
  `sub`" for 10 minutes. A member verifies the assertion against the login key recorded in the mesh's
  `account` record and signs the `admit` itself, so the service cannot add a machine to a mesh on its
  own, and a mesh keeps working when the service is down. What it can do is admit any machine to an
  unlocked mesh by asserting a false account; `pen lock on` moves that decision to a member.

## Keys that cannot be replaced quietly

- **`LOGIN_SIGNING_KEY`.** Every bound mesh pins the login key's `kid` and public key in its `account`
  record. A new key makes every assertion fail on every existing mesh until one member of each mesh runs
  `pen login` again, which signs a new `account` record with the new key (the rebind path is
  `TestLoginOnAMemberBindsAgainAfterAnUnbindOrAKeyRotation`). That rebind is also the rotation: assertions
  live 10 minutes and members verify against the bound key only, so serving two keys at once would buy
  nothing. The Worker secret cannot be read back, so the only copy outside Cloudflare is the operator's
  backup (see the runbook).
- **A node's identity.** `~/.pen/identity.json` is the node. A relay keeps one uplink per node id and
  closes the older one 4409, and a node that gets 4409 stops instead of reconnecting
  ([contract](../../packages/pen-protocol/CONTRACT.md#relay)). Two machines sharing an identity, such as boxes
  made from an image that contained `~/.pen`, therefore knock each other offline. Never bake `~/.pen`
  into an image; join each machine on its first boot. A startup guard cannot catch a clone by
  `/etc/machine-id`: boxes.dev forks the whole VM, so a box made from the template keeps its machine id
  and even its boot id (checked 2026-11-10). Detecting a clone needs a value the platform makes unique per
  box.

## Revocation and compromise

`pen revoke --compromised` also revokes every key the member admitted, and drops its `account` records
and its lock `off` records while keeping its lock `on` records
([mesh records](../../packages/pen-protocol/CONTRACT.md#mesh-records)). The asymmetry is deliberate:
revoking a stolen machine must never unlock the mesh or keep a binding it signed, and a stray `on` costs
nothing because any member can sign `off` after it. When the stolen machine had signed the binding,
members fall back to the previous binding's login service to send forgets, so it leaves the account's
registry too (`forgetRevoked` in `apps/pen/internal/daemon/account.go`).

`account` and `lock` records stall a v1.0 node, so a member signs one only when every member has announced
`"pen":"1.1"` in a sync hello. The last announced version is kept in `versions.json` so one offline member
that already announced does not block the mesh; a member that never announced still does.

## What lock mode and the registry do not guarantee

- **Lock binds only members that hold it.** Before deciding a Google join a member syncs with every member it
  can reach for up to 5 s, so a lock it slept through still counts. A member that reaches none of the members
  holding the lock decides on its own view and can admit. The same holds for an unbind or a revoke.
- **A served copy can be cut.** The member that admits a new machine chooses which records to send. A revoked
  or stolen machine that the registry still lists could send its own admit and its revokes of the honest
  members. The joiner therefore also syncs with every node the registry listed that its copy does not count
  as a member (`FinishJoin` in `apps/pen/internal/daemon/account.go`). One that refuses it is asked to check
  the joiner's records against its own view (`serveCheck` in `apps/pen/internal/mesh/check.go`); the join
  fails only if it still refuses, which it does when the joiner's admits pass a key its own view revoked
  (plainly or as compromised) before reaching one it counts as a current member. Two honest cases refuse too:
  a machine admitted by a since-revoked key that this node has not heard of yet, which passes once the members
  sync, and a machine whose admit lost to a concurrent revoke of its admitter in the canonical order, which was
  never a member anywhere and must join again (`admittedCleanly` and its tests in `mesh/check_test.go`). Such a
  machine admits nobody: the Google join (after its refresh), the invite (before it is used) and `pen approve` all
  check `mesh.IsMember` before signing, and the refusal carries `notMember` so a Google joiner tries the next
  listed machine. The check and the signature (and the invite's burn, or queueing a request) hold the mesh
  store's lock together (`Store.AppendAsMember`, `Store.DoAsMember`), so a revoke merged in between still stops
  them. `pen ls` on such a machine says it is not a member and how to start over. This protects a join only while an honest listed node answers: a listed node that is offline,
  out of session slots or slower than the 30 s push timeout takes no part, and one older than the check
  (pen 0.2.6 and before) still refuses every joiner it does not know.
- **The registry is not the mesh.** Any node with a valid sign-in for the account registers, even one a locked
  mesh only queued, and any registered node can remove the others from the account's list. One phished
  sign-in can therefore make the service offer new machines only the attacker's node. Members and invites
  are unaffected; the remedy is lock mode plus the reset page. Binding registration to a member's
  signature would close this and is not done. A forget that the service refuses because the revoking
  node is not registered shows in `pen ls` and the dashboard instead of retrying silently.

## Mesh state on disk

`mesh.json` decides what may replace it, because more than one writer can hold a set for it: an older save
of the same store, the store of a mesh this node just left (`replaceMesh`), or another process (`pen join`
or `pen login` while no daemon runs). Under the state lock a save reads the file first: for the same mesh it
writes the union with the file's records (records only grow), for another mesh it writes nothing unless the
store was adopted (`Store.Adopt`), and after the file was removed (`pen leave`) it does not recreate it
(`Store.SaveFile`). `config.json` changes read to write under the same lock (`state.UpdateConfig`).

A merge reaches memory before disk. When the save fails the store knows it holds unsaved records
(`Store.Unsaved`): no sync is acknowledged (4507) until a save succeeds, the daemon retries on every push
and every minute, and `pen ls` shows the error until then. Meanwhile the daemon enforces the view in memory:
a revoke it holds but could not write still closes that peer's sessions, which errs toward the revoke; a
restart before a successful save forgets it until a member sends it again.

The record space is shared: no signer has a quota, so one member can fill it with valid records (3840
ordinary ones, then revokes to 4096), after which no member can record anything, its own revoke included.
The remedy is a new mesh; issue #2864 tracks a bound that admitted keys cannot multiply.

## Lock order

Three rounds of review findings came from locks taken in the wrong order or released between a check and
the step it guards. The daemon takes them in this order only, never back:

1. The per-file save mutexes (`Store.saveMu`, `cfgSave`, `versionsSave`): one save of that file at a time.
2. `Daemon.mu` (sessions, presence, `saveErr`), then the store's `Store.mu` (`viewChanged` and
   `register` read the view under `Daemon.mu`). Nothing holding `Store.mu` takes `Daemon.mu`.
3. Under `Store.mu`: the decision callbacks of `Store.AppendAsMember` and `Store.DoAsMember`, which check
   membership, the binding and the lock against the view of that moment, burn an invite (`Invites.mu`) or
   queue a request (`pendingBook.mu`), and sign. `Merged` callbacks run after `Store.mu` is released.
4. The state lock (`state.Lock`, a file lock that also orders other processes) last. A save takes its
   snapshot under `Store.mu`, releases it, then takes the state lock and does not take `Store.mu` again
   while it holds it, since an invite burn holds `Store.mu` while it writes `offers.json`.

`Daemon.meshMu` only guards which store and invite book are current and is never held across a call into them.

## Dials

Kind 0x01 sessions (TCP and mesh sync) race the Noise handshake on every relay and confirm only the first
verified message 2, because the first `pong` only proves a relay is up, while the path back from the node
is what costs time. This is safe only because a responder acts after key confirmation. Joins (0x03) and
account sessions (0x04) keep the ping race: their message 1 spends a single-use invite or reserves one
of four account slots, so it must travel on one socket (Doriterm #1351).

## Why a Seoul relay

Requests from Korea to this account's Worker were served at LAX, so a dial between two Seoul machines through the
Worker crossed the Pacific twice: `/healthz` took 0.9 to 1.9 s from Korea against 20 to 30 ms for a Go relay
on an Oracle VM in Chuncheon. With the handshake race, a box in Oregon reaching a Mac in Seoul picks the
Seoul relay on its own, and a forwarded HTTP request fell from about 2.3 s to 0.87 s. The Worker stays first in
the list because it also serves the installer and binaries.

## Dashboard

`pen dashboard` runs on `127.0.0.1` with a random port, and anything on that machine can reach the port.
Cookies are not isolated by port, so the page never uses one: a single-use token arrives in the URL
fragment (from a 0600 file, never a process argument), is exchanged for a bearer kept in
`sessionStorage`, and every response carries an HMAC of that bearer under a per-start key. A tab that
sees a missing or wrong server id, a network error or a timeout stops for good, because a process that takes
the port after the dashboard stops would otherwise be trusted by the open tab. Every action goes through
the same daemon operation as the CLI.
