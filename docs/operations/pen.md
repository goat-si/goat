# Pen operations

> For maintainers. Using Pen? See [Pen](../user/pen.md). Design reasons are in [internals](../internals/pen.md).

Pen has three hosted pieces, all on the Cloudflare account `88fe49abfe560e75daf6b53b0398bed8` except the Go relay:

| Target      | Where                                                                                                        | Source                     |
| ----------- | ------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `pen-relay` | Worker and Durable Objects, `https://pen-relay.pos090001.workers.dev`; also serves `install.sh` and binaries | `infra/pen-relay`          |
| `pen-login` | Worker and one Durable Object, `https://pen-login.pos090001.workers.dev`                                     | `infra/pen-login`          |
| Seoul relay | `pen relay serve` on the Oracle VM `clisu-oracle` (ap-chuncheon-1), `wss://158-180-76-7.sslip.io`            | `apps/pen` (`relayserver`) |

Deploy from a checkout of the commit you mean to ship, after its `goat-ci-result` is green (the `test-pen` task runs
every Pen suite). `wrangler whoami` must list only the account above.

## Check a relay

`pen relay check <url>` checks a relay end to end: `/healthz`, the certificate's expiry, and a check node that
uplinks and exchanges 64 KiB each way with a client through the relay, with timings. It exits 1 on any failure or
when `--timeout` (30 s) runs out, including a certificate that expires within 14 days (`--min-cert-days`), so it
works as a cron or monitor probe. The check node's keys live in `relay-check/` under the state directory
(`~/.pen`, or `PEN_HOME`), separate from the machine's own node, so repeated checks reuse one node id and leave each
relay one small entry (the Go relay its next session id for that node, the Worker one Durable Object holding the same).
That directory must be writable by the user the probe runs as; a cron job under another user or a read-only home
sets `PEN_HOME` to a directory it owns. Checks on one machine take turns with the check node: a second check started
while one runs waits for it, within its own `--timeout`. Run it against both relays after every deploy:

```sh
pen relay check https://pen-relay.pos090001.workers.dev
pen relay check https://158-180-76-7.sslip.io
```

## Release the node

```sh
apps/pen/scripts/build.sh <version> https://pen-relay.pos090001.workers.dev https://158-180-76-7.sslip.io
```

The first URL is the download relay; every URL becomes a relay of nodes installed with that `install.sh`. Output goes
to `infra/pen-relay/public/` (`dl/<version>/` with four gzipped binaries, `SHA256SUMS` and `NOTICE`, and
`install.sh`), which is gitignored and published by the next `pen-relay` deploy. A deploy serves exactly what that
folder holds, so a deploy from another checkout drops older releases: copy the previous `dl/<version>/` in first
(download it from the Worker and check it with `shasum -a 256 -c SHA256SUMS`) so nodes can roll back. An `install.sh`
downloads the version it was built for unless `PEN_VERSION` names another.
Upgrade a running node by replacing its
`~/.local/bin/pen` (or rerunning `install.sh`) and restarting it with `pen down` and `pen up`.

## pen-relay Worker

Deploy: in `infra/pen-relay`, `pnpm run deploy` after a `build.sh`; it is the only supported deploy command, since a
plain `wrangler deploy` publishes `public/` unchecked. `public/dl/` is gitignored, so a fresh checkout has no
release to publish until `build.sh` runs (and copies of older releases are added, see above). The deploy first runs
`scripts/check-public.ts`, which refuses a `public/install.sh` whose relays are loopback or plain http (a local test
build), or whose version lacks one of the four archives in `dl/<version>/` or has one that does not match
`SHA256SUMS`. Then `node scripts/smoke.ts https://pen-relay.pos090001.workers.dev`: it checks `/healthz`, that the upgrade
offers no compression, moves 1 MiB each way between a fresh node and a client, and prints close latency. Check one
served build with `curl -fsS .../dl/<version>/SHA256SUMS` against the local file.

Rollback: `pnpm exec wrangler deployments list`, then `pnpm exec wrangler rollback <version-id>`. Static assets roll
back with the version. Each node id's Durable Object keeps only its next session id beyond its sockets, so a rollback
loses only open sockets, which reconnect.

## pen-login Worker

Secrets: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` come from the Google OAuth web client of the `pen-login`
Google Cloud project (the client file lives on the operator machine, mac-studio, at
`~/.pen-secrets/google-oauth-client.json`, mode 0600). `LOGIN_SIGNING_KEY` is the Ed25519 seed of the login key.
None can be read back from Cloudflare, so the login key's only other copy is the file `deploy:secrets` created it in
(keep it at `~/.pen-secrets/login-signing-key` on the operator machine, and an offline copy).

Deploy: in `infra/pen-login`,
`pnpm run deploy:secrets <google-oauth-client.json> [--signing-key-file <path>]` sets the secrets and deploys in one
version. When the Worker has no `LOGIN_SIGNING_KEY` it needs `--signing-key-file`: an existing file restores that key,
a missing one is created there (0600, in a 0700 directory outside the repository) with a new key, and the script prints
the key's `kid`. When the Worker has a key it keeps it and refuses a key file. A code-only change uses
`pnpm run deploy`. Check `GET /v1/keys`: its `kid` must not change across deploys, because every bound mesh pins
it. `GET /` answers 303 to `/device`.

Rollback: as for pen-relay. The `Login` Durable Object holds the account registry, device codes and rate-limit
counters in SQLite; a rollback keeps that data, so roll back only to a version whose schema reads it.

Rotate the Google client secret: add a new secret to the OAuth client in the Google Cloud console, put it in the client
file, run `deploy:secrets <client file>` (the Worker keeps its login key), check one sign-in, then disable the old
secret in the console. Sign-ins in flight during the deploy fail once; nothing else changes.

Moving the service: `deploy:secrets` with `--signing-key-file` pointing at the kept file restores the same key, and
the Durable Object's data moves with the Worker, so bound meshes notice nothing.

Recovering a deleted Worker: the same command restores the key, but the account registry was in the deleted
`Login` Durable Object, so every account starts with no registered mesh. Until one member of a mesh signs in again, a
new machine that signs in gets no mesh offer and `pen login` offers to found a new mesh, which would then take the
account's registration. So before reopening sign-ins, ask each person to run `pen login` on one existing member: with
no mesh registered it asks `No mesh is registered for <email>. Bind this machine's mesh <id> (N members)?`, and yes
registers that mesh again. If a new machine already founded a second mesh, its members get `pen leave first`: reset
the account at `/reset` on the sign-in page, run `pen login` on an existing member first, then on the stray machine run
`pen leave` and `pen login` to join the real mesh.

### Rotate the login key and rebind

Use this to rotate `LOGIN_SIGNING_KEY`, to replace a leaked one, or to create the operator copy for a key that has
none. There is no overlap period: assertions live 10 minutes and members check them only against the key their mesh is
bound to, so each mesh moves to the new key when one of its members signs in again.

1. In `infra/pen-login` of the deployed commit, on the operator machine: `pnpm exec wrangler whoami` lists only the
   Pen account, and `curl -s https://pen-login.pos090001.workers.dev/v1/keys` shows the old `kid`.
2. `pnpm exec wrangler secret delete LOGIN_SIGNING_KEY`. That publishes a version without the key, so sign-ins fail
   until the next step; run it at once.
3. Move the old key file aside first (`mv ~/.pen-secrets/login-signing-key ~/.pen-secrets/login-signing-key.<old kid>`):
   with a file at that path, `deploy:secrets` restores the key it holds instead of making a new one.
4. `pnpm run deploy:secrets ~/.pen-secrets/google-oauth-client.json --signing-key-file ~/.pen-secrets/login-signing-key`
   (the directory must be 0700). It creates the key there and prints `login key kid <new> from <path>`; a printed
   `<old>` means it restored the old key, so stop and check step 3. Copy the new file somewhere offline.
5. `curl -s .../v1/keys` now shows `<new>`.

While a mesh is still bound to the old key, members, invites, `pen pipe`, `pen forward` and SSH keep working, and
`pen account` on a member still shows `login key <old>`. A new machine can sign in at `/device`, but every member
refuses it and its `pen login` ends with `login: assertion is not signed by this login key`.

6. On one member of each bound mesh, the person runs `pen login` and signs in with the mesh's Google account. It asks
   `Mesh <id> is bound to an older login key (<old>). Bind it to the service's current key <new>?` and, after yes,
   prints `mesh <id> is bound to <email> again`. Like any binding change this needs every member to have announced pen
   1.1; a member that never did blocks it with a message naming that member.
7. Confirm: `pen account` on that member, and on the others after their next sync (`pen ls` shows them online),
   prints `login key <new>`. A test sign-in of a new machine now joins.

For the operator's own mesh (mac-studio, `PEN_HOME=~/goat-research/pen-boxes-test/.penhome/state`), step 6 is
`pen login` there with that `PEN_HOME`.

## Seoul relay

The VM (`clisu-oracle`, Ubuntu on arm64) runs `/opt/pen-relay/pen relay serve` under the system unit
`apps/pen/install/pen-relay.service`, installed as `/etc/systemd/system/pen-relay.service`. It runs as a dynamic
user with a read-only system and no access to home directories (`systemd-analyze security pen-relay` rates it 1.6).
Its memory ceiling is 768 MiB with `GOMEMLIMIT=224MiB`, sized for the caps the unit passes: 1024 connections, 64 per
source address, 128 MiB of queued data with 16 MiB per source. The unit's comment carries the arithmetic and the
measurement; change the caps, `GOMEMLIMIT` and `MemoryMax` together. A relay at its caps refuses new connections and
ends the sessions of whichever source fills its share (4408 in the nodes' logs); it does not run out of memory.
`/etc/pen-relay.env` sets `PEN_RELAY_LISTEN=10.0.0.222:443`
(the VCN's private address behind the public `158.180.76.7`) and `PEN_RELAY_HOST=158-180-76-7.sslip.io`. The
Let's Encrypt account and certificate are cached in `/var/lib/pen-relay/acme` (systemd keeps it in
`/var/lib/private/pen-relay`).

Install on a new VM: put the binary at `/opt/pen-relay/pen` (0755), write `/etc/pen-relay.env`, copy the unit file,
then `sudo systemctl daemon-reload && sudo systemctl enable --now pen-relay`. To keep an existing certificate, copy its
cache into `/var/lib/private/pen-relay/acme` before the first start; systemd hands it to the service user.

Deploy a new binary: copy `pen-linux-arm64` from the build (gunzip it) to the VM, `sudo cp /opt/pen-relay/pen
/opt/pen-relay/pen.prev`, `sudo install -m 0755 <new> /opt/pen-relay/pen`, `sudo systemctl restart pen-relay`, then
`pen relay check https://158-180-76-7.sslip.io`. When the unit file changed too, copy it to
`/etc/systemd/system/pen-relay.service` (keep the old one as `pen-relay.service.prev`) and run
`sudo systemctl daemon-reload` before the restart. Rollback installs `pen.prev` the same way. Logs:
`journalctl -u pen-relay`; TLS handshake errors from scanners are normal there.

Certificates: `autocert` renews a certificate when a third of its lifetime is left (30 days for Let's Encrypt's
90-day certificates, with up to an hour of jitter) while the process runs, and a restart reuses the cached certificate
(the 2026-11-10 move to this unit kept serial `051E01E7…E463`). A failed renewal is retried every 30 to 60 minutes and
is not logged; the relay keeps serving the cached certificate until it expires, and after that every TLS handshake
fails until issuance succeeds. A failed first issuance does the same and the process keeps running. So the alarm is
`pen relay check`, which fails 14 days before expiry. Issuance needs port 443 reachable from the internet
(TLS-ALPN-01); restarting the service retries at once.

## Incidents

**A member was lost or stolen.** On any other member: `pen revoke <member> --compromised` (by node id or fingerprint
when a replacement joined under the stolen machine's name; the command refuses such a name and lists both; this also works for a
machine that already left or was revoked plainly, and revokes every machine it admitted), then `pen lock on`. If the
mesh is bound to a Google account, change that account's password and reset its machine list from the reset link on
`https://pen-login.pos090001.workers.dev/device`. The revoke goes to every online member at once and reaches the others
at their next sync (every 10 minutes and whenever their uplink returns); each member refuses the key as soon as it has
the revoke. `pen ls --watch --until-revoked <member>` on another member shows when it arrived. If `pen ls` then says
the login service still offers the removed machine, this machine is not registered with the account: run `pen login`
here, or use the reset link.

**Someone else could sign in to the account.** The login service registers any machine with a valid sign-in, even one
a locked mesh only queued, and any registered machine can remove the others from the account's list, so new machines
would be offered only that one. Lock the mesh, then reset the account's machine list at `/reset` and run `pen login`
on one trusted member.

**A relay is down.** Nodes keep working through their other relays; dials race every relay, so no action is needed for
running meshes. New installs need the download relay (the Worker). Check `/healthz` on each relay and, for the Worker,
`node scripts/smoke.ts`. A node with only the failed relay reconnects on its own when it returns.

**The login service is down.** Existing meshes and invites keep working; only Google sign-in for new machines fails.
