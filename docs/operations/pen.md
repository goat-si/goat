# Pen operations

> For maintainers. Using Pen? See [Pen](../user/pen.md). Design reasons are in [internals](../internals/pen.md).

Pen has three hosted pieces, all on the Cloudflare account `88fe49abfe560e75daf6b53b0398bed8` except the Go relay:

| Target      | Where                                                                                                        | Source                     |
| ----------- | ------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `pen-relay` | Worker and Durable Objects, `https://pen-relay.pos090001.workers.dev`; also serves `install.sh` and binaries | `infra/pen-relay`          |
| `pen-login` | Worker and one Durable Object, `https://pen-login.pos090001.workers.dev`                                     | `infra/pen-login`          |
| Seoul relay | `pen relay serve` on the Oracle VM `clisu-oracle` (ap-chuncheon-1), `wss://158-180-76-7.sslip.io`            | `apps/pen` (`relayserver`) |

Deploy from a checkout of the commit you mean to ship, after its `goat-ci-result` is green (the `test-pen` task runs
every Pen suite, and `test-pen-windows` the Go suite and install check on Windows). `wrangler whoami` must list only the account above.

## Check a relay

`pen relay check <url>` checks a relay end to end: `/healthz`, the certificate's expiry, and a check node that
uplinks and exchanges 64 KiB each way with a client through the relay, with timings. It exits 1 on any failure or
when `--timeout` (30 s) runs out, including a certificate that expires within 14 days (`--min-cert-days`), so it
works as a cron or monitor probe. The check node's keys live in `relay-check/` under the state directory
(`~/.pen`, or `PEN_HOME`), separate from the machine's own node, so repeated checks reuse one node id. The Go relay
keeps nothing for it once the check's sockets close; the Worker keeps one Durable Object holding that node id's next
session id.
That directory must be writable by the user the probe runs as; a cron job under another user or a read-only home
sets `PEN_HOME` to a directory it owns. Checks on one machine take turns with the check node: a second check started
while one runs waits for it, within its own `--timeout`. Run the same build of `pen` as the relay (see
"Deploy a new binary" under Seoul relay): a check from pen 0.2.5 or 0.2.6 fails 4408 against a newer Go relay. Run it against both relays after every deploy:

```sh
pen relay check https://pen-relay.pos090001.workers.dev
pen relay check https://158-180-76-7.sslip.io
```

## Release the node

```sh
apps/pen/scripts/build.sh <version> https://pen-relay.pos090001.workers.dev https://158-180-76-7.sslip.io
```

The first URL is the download relay; every URL becomes a relay of nodes installed with that `install.sh`. Output goes
to `infra/pen-relay/public/` (`dl/<version>/` with six gzipped binaries for Linux, macOS and Windows, `SHA256SUMS` and
`NOTICE`, and `install.sh` and `install.ps1`), which is gitignored and published by the next `pen-relay` deploy. A deploy serves exactly what that
folder holds, so a deploy from another checkout drops older releases: copy the previous `dl/<version>/` in first
(download it from the Worker and check it with `shasum -a 256 -c SHA256SUMS`) so nodes can roll back. An `install.sh`
downloads the version it was built for unless `PEN_VERSION` names another.
Upgrade a running node by replacing its
`~/.local/bin/pen` (or rerunning `install.sh`, or `install.ps1` on Windows, which renames a running `pen.exe` aside)
and restarting it with `pen down` and `pen up`. `apps/pen/scripts/installcheck.ps1` is `installcheck.sh` for Windows.
A node on pen 0.2.6 or older does not know the Google join's check: while it is listed for the account and refuses a
new machine it has not heard of (it left, or has not synced yet), that machine's `pen login` fails naming it.
Upgrade it, or add the machine with an invite.
`pen up` rewrites the service unit or plist; replacing the binary does not. A unit written by pen 0.2.6 or older runs
`pen up --foreground` without `--service`, and a refused start (a stored relay list pen no longer accepts) then exits
non-zero. pen recognises such a start by `SYSTEMD_EXEC_PID` (systemd 248 and later) or by `XPC_SERVICE_NAME` being
`si.goat.pen` (launchd) and exits 0 as the new unit does. On systemd older than 248, an upgraded old unit keeps restarting every 2 s
(`Restart=on-failure`, `RestartSec=2`; five starts take about 8 s, so the default limit of 5 starts in 10 s is not
reached) until `pen up` is run once, which rewrites the unit; meanwhile `journalctl --user -u pen` shows the refusal
(`pen: the relays in config.json cannot be used ...`) and a restart every 2 s. A shell or container that carries `XPC_SERVICE_NAME=si.goat.pen`, or
the internal `--service` flag, likewise makes a refused `pen up --foreground` print the reason and exit 0.

## pen-relay Worker

Deploy: in `infra/pen-relay`, `pnpm run deploy` after a `build.sh`; it is the only supported deploy command, since a
plain `wrangler deploy` publishes `public/` unchecked. `public/dl/` is gitignored, so a fresh checkout has no
release to publish until `build.sh` runs (and copies of older releases are added, see above). The deploy first runs
`scripts/check-public.ts`, which refuses a `public/install.sh` whose relays are loopback or plain http (a local test
build), or whose version lacks one of the six archives in `dl/<version>/` or has one that does not match
`SHA256SUMS`, and a missing `public/install.ps1` or one whose relays or version differ from `install.sh`'s. Then
`node scripts/smoke.ts https://pen-relay.pos090001.workers.dev`: it checks `/healthz`, that the upgrade
offers no compression, moves 1 MiB each way between a fresh node and a client, and prints close latency. Check one
served build with `curl -fsS .../dl/<version>/SHA256SUMS` against the local file.

Rollback: `pnpm exec wrangler deployments list`, then `pnpm exec wrangler rollback <version-id>`. Static assets roll
back with the version. Each node id's Durable Object keeps only its next session id beyond its sockets (and a listed node's traffic row), so a
rollback loses only open sockets, which reconnect; an older version ignores the row and a later one adds to it.

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

Moving the service to another Worker name, host or Cloudflare account costs every bound mesh a sign-in. A new Worker
starts with an empty `Login` Durable Object (no account registry), its assertions carry its own origin as `iss`,
and every member accepts only assertions whose `iss` is the login URL its mesh is bound to. Steps:

1. Add `https://<new host>/v1/auth/google/callback` to the Google OAuth client's redirect URIs and set `CALLBACK`
   in `infra/pen-login/scripts/deploy.ts` to it (the script refuses a client file without it).
2. Point `wrangler.jsonc` at the new name or account and run `deploy:secrets` with `--signing-key-file` naming the
   kept key file, so `/v1/keys` on the new host shows the same `kid`.
3. On one member of each bound mesh the person runs `pen login --login-url https://<new host>` (or sets
   `PEN_LOGIN`). The new registry has no mesh, so it asks `No mesh is registered for <email>. Bind this
   machine's mesh <id> (<n> members) to <email>?` (on a mesh of one machine: `No mesh is registered for <email>.
   Found a mesh with this machine and bind it to <email>?`, which binds the existing mesh); yes binds the mesh to
   the new URL and registers this
   machine. The other members take the binding at their next sync. Every member must have announced pen 1.1.
4. New machines reach the new service only with `--login-url` or `PEN_LOGIN` until a release changes
   `login.DefaultURL` in `apps/pen/internal/login/login.go`.
5. Delete the old Worker once every mesh moved; until then it keeps signing in machines for meshes still bound to it.

Recovering a deleted Worker: the same command restores the key, but the account registry was in the deleted
`Login` Durable Object, so every account starts with no registered mesh. Until one member of a mesh signs in again, a
new machine that signs in gets no mesh offer and `pen login` offers to found a new mesh, which would then take the
account's registration. Pen has no switch that closes sign-ins, so ask each person right away to run `pen login` on
one existing member: with no mesh registered it asks `No mesh is registered for <email>. Bind this machine's mesh
<id> (<n> members) to <email>?`, and yes registers that mesh again. If a new machine already founded a second mesh,
`pen login` on the existing members says `pen leave first` (the account is registered with the stray mesh): reset
the account at `/reset` on the sign-in page, run `pen login` on an existing member first, then on the stray machine
run `pen leave` and `pen login` to join the real mesh.

### Rotate the login key and rebind

Use this to rotate `LOGIN_SIGNING_KEY`, to replace a leaked one, or to create the operator copy for a key that has
none. There is no overlap period: assertions live 10 minutes and members check them only against the key their mesh is
bound to, so each mesh moves to the new key when one of its members signs in again.

1. In `infra/pen-login` of the deployed commit, on the operator machine: `pnpm exec wrangler whoami` lists only the
   Pen account, and `curl -s https://pen-login.pos090001.workers.dev/v1/keys` shows the old `kid`.
2. Move the old key file aside (`mv ~/.pen-secrets/login-signing-key ~/.pen-secrets/login-signing-key.<old kid>`):
   with a file at that path, `deploy:secrets` restores the key it holds instead of making a new one.
3. `pnpm exec wrangler secret delete LOGIN_SIGNING_KEY`. That publishes a version without the key, so every sign-in
   fails from here until step 4 deploys; run step 4 at once.
4. `pnpm run deploy:secrets ~/.pen-secrets/google-oauth-client.json --signing-key-file ~/.pen-secrets/login-signing-key`
   (the directory must be 0700). It creates the key there and prints `login key kid <new> from <path>`; a printed
   `<old>` means it restored the old key: the Worker runs with the old key again, so check step 2 and repeat from
   step 2. Copy the new file somewhere offline.
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
The unit passes 1024 connections, 64 per source address, and 128 MiB of queued data with 16 MiB per source; the unit's
comment adds up what each part may hold at worst against `MemoryMax` and records the measured peaks. `GOMEMLIMIT`
only makes the collector work harder near it; it is not a cap, so the margin under `MemoryMax` is headroom, not a
proof. Change the caps, `GOMEMLIMIT` and `MemoryMax` together. A relay at its caps refuses new connections. Queued data is charged to the session's 4 MiB window, the
16 MiB share of the address that will receive it, and the 128 MiB total; data that does not fit any of them ends the
session that sent it with 4408, and nothing else ends because of memory: no other session and never an uplink. A
socket that stops reading is closed only when one write stalls for 10 s. A new client session is admitted only if
its OPEN and CLOSE frames toward the node fit like data (and within 256 KiB of such frames per uplink); otherwise it
is refused 4429, so clients that open and close faster than a slow node reads get refused instead of ending the
node's uplink. Pongs, the challenge and close frames are not charged (about 1.4 KiB per socket at most), so a full
relay still answers uplinks. Before a node answers a session, its client may send one message of at most 4 KiB;
anything more ends that session. Past 8 pending sessions per node, the address holding the most loses its oldest
(4429), so one address cannot push out another's. One address therefore cannot end another address's
sessions, and data between other addresses fits while they hold less than the total minus one share (112 MiB). What
can still happen, each time as 4408 on the refused session, with nothing reopened by itself and the node's other
relay unaffected: a peer the node has answered can fill that node's 4 MiB uplink window while the node reads slowly,
and other sessions' data toward the node is refused until it reads; machines behind one NAT address share its 16 MiB,
so about four sessions whose clients stopped reading (each may queue its 4 MiB window) leave the address's other
sessions refused until those clients read or their writes time out after 10 s; a flood from many addresses fills
the relay for everyone until the stalled sockets time out. When every connection slot is taken, a Let's Encrypt validation connection
is refused like any other; `autocert` renews 30 days before expiry and retries every 30 to 60 minutes, and
`pen relay check` fails 14 days before expiry, so a renewal fails only if the relay stays full for weeks.
`/etc/pen-relay.env` sets `PEN_RELAY_LISTEN=10.0.0.222:443`
(the VCN's private address behind the public `158.180.76.7`) and `PEN_RELAY_HOST=158-180-76-7.sslip.io`. The
Let's Encrypt account and certificate are cached in `/var/lib/pen-relay/acme` (systemd keeps it in
`/var/lib/private/pen-relay`).

Install on a new VM: put the binary at `/opt/pen-relay/pen` (0755), write `/etc/pen-relay.env`, copy the unit file,
then `sudo systemctl daemon-reload && sudo systemctl enable --now pen-relay`. To keep an existing certificate, copy its
cache into `/var/lib/private/pen-relay/acme` before the first start; systemd hands it to the service user.

Deploy a new binary in this order. First, before the relay, install the same build of `pen` on every machine that
runs `pen relay check` against this relay (your own machine, and any cron job or monitor). A check from pen 0.2.5
or 0.2.6 against a relay newer than 0.2.6 prints `ok: healthz …` and then `FAIL: client to node: closed 4408` and
exits 1, although the relay works: that check sends 64 KiB before its node answers, which the relay now refuses.
Nodes of those versions are not affected. Then copy `pen-linux-arm64` from the build (gunzip it) to the VM, `sudo cp /opt/pen-relay/pen
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

## Relay traffic

Both relays count the payload bytes they deliver for each session: toward the node (`toNode`) and toward its client
(`fromNode`). A byte counts once the relay's write of it to the other end succeeded. They record nothing else: no
address, no headers, nothing from a session. Anyone can mint a node id, so per-node numbers are kept only for the node
ids the operator lists; the Go relay names them by their first 8 characters, as `pen ls` shows them.

**Go relay.** `pen relay serve` writes JSON lines to stderr, so on the Seoul VM they are in the journal. List your nodes
in `/etc/pen-relay.env` as `PEN_RELAY_TRAFFIC_NODES=<id>,<id>` (full ids from `pen ls --json`, at most 256; the unit
passes them as `--traffic-nodes`) and restart the service. With no list the relay writes only its `relay` lines.

- `session`, once per session a listed node answered, when it ends: `node`, `toNode`, `fromNode`, `ms`, `end`
  (`client`, `node`, `relay` or `uplink`: which side ended it), the close `code` and `at`. Lines are limited to a burst
  of 120, then one a second.
- Every 10 minutes when something changed, a `node` line per listed node that changed (totals since `since`) and one
  `relay` line: every session's bytes since the process started, plus `unanswered`, `linesDropped` and `nodes` (how many
  listed nodes have numbers). Open sessions are counted as they go, so a tunnel open for days shows every 10 minutes.
  On a clean stop the relay ends open sessions (`relay`, code 1001) and writes these lines once more.

Lines wait in a queue of 1024 for the journal; a line that does not fit, or that the session line limit holds back, is
dropped and counted in `linesDropped`, and the totals still hold its bytes. Totals live in memory and start from zero
when the process restarts. The journal keeps the lines until its size cap (`journalctl --disk-usage`; `SystemMaxUse`
in `journald.conf`).

```sh
journalctl -u pen-relay -o cat | grep '^{"event":"relay"' | tail -1
journalctl -u pen-relay -o cat --since today | grep '^{"event":"session"' |
  jq -s 'group_by(.node) | map({node: .[0].node, toNode: (map(.toNode) | add), fromNode: (map(.fromNode) | add), sessions: length})'
```

**Worker.** It logs nothing: Workers Logs would keep request URLs, which hold the full node id. List your nodes with
`pnpm exec wrangler secret put TRAFFIC_NODES` in `infra/pen-relay` (full ids, comma-separated); a secret keeps the ids
out of the repository and survives deploys. Each listed node's Durable Object keeps one row in a `traffic` table
(`to_node`, `from_node`, `sessions`, `unanswered`, and `since` and `at` in ms since the epoch). Read it in the
dashboard under Workers & Pages, Durable Objects, the `Room` namespace of `pen-relay`, Data
Studio: enter the full node id and run `SELECT * FROM traffic`. Anyone on the Cloudflare account whose role can edit
this Worker can read the row there, and those queries are billed as Durable Object use. The row stays as long as the
object, across deploys and rollbacks.

Taking a node off the list, or unsetting the secret, stops counting new traffic for it; rows already written stay. To
remove one, take the node off the list first. A secret change deploys a new version, and an active Room can keep running
the previous version for up to 5 minutes (Cloudflare's default deferral); a Room on the new version checks the list
before every write and drops the counts of a node no longer listed. So wait at least 5 minutes, run
`DROP TABLE traffic` in Data Studio for that node's object, and check a few minutes later that it stayed gone (drop it
again if not). Data Studio needs Editor access to the Worker and records every query in the account's audit log. There
is no other way to remove a row.

The Room writes the row at most once a minute; Cloudflare may run the alarm that writes it up to a minute late during
maintenance or failover, so the row can trail by about two minutes. Bytes not written yet ride on the node's uplink
socket and survive hibernation; sessions that ended while the node had no uplink are lost if the object is evicted
before the next write. A row costs one table page (4 KiB) per listed node.

**After a deploy.** Run `pen relay check` against each relay. On the VM, the next `relay` line (within 10 minutes,
`journalctl -u pen-relay -o cat -n 20`) counts the check's sessions, a listed node's sessions get `session` lines, and no
line holds an address. For the Worker, read a listed node's row in Data Studio after it carried a session.

**Check the numbers against the VM.** Each delivered byte was received once and sent once, so a day's growth of the
`relay` line's `toNode` plus `fromNode` tracks the interface's `tx_bytes` growth over the same day; TCP, TLS and
WebSocket overhead and the VM's own traffic make up the rest. On a relay carrying bulk sessions (model traffic, file
copies) the gap is expected within about 10%; on a quiet relay, small messages, keepalives and the VM's other traffic
can make it larger, so read a wider gap there as overhead before suspecting the counts. Right after a `relay` line, read
`/sys/class/net/<interface>/statistics/tx_bytes` (the interface holding the private address, `ip -br addr`) and note
the line; repeat a day later and compare the differences. The relay must not restart in between
(`systemctl show pen-relay -p ExecMainStartTimestamp`). `rx_bytes` grows by the same amount plus scanners and refused
data.

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
would be offered only that one. Change the Google password first, lock the mesh, then reset the account's machine list
at `/reset` and run `pen login` on one trusted member. A reset ends everything that predates it for that account:
the machine list and the account's mesh registration, sign-in codes approved but not yet collected, codes a browser
signed in as that account was confirming, browser sign-ins waiting at their confirmation page, sign-ins that had left
for Google before the reset and return after it, and sign-in results not yet registered. After it, only a new Google
sign-in leads to a machine being registered, and the members of an existing mesh are not changed. A device code is denied for every
account whose browser was confirming it, so when browsers signed in to two accounts are at the confirmation page of
the same code, a reset of one denies the code for both; the other account's registry and sessions are untouched.

**One member filled the mesh's record space.** `pen ls` says `mesh full`. A mesh keeps at most 4096 records and no
signer has a share of its own, so a hostile member can fill it with valid records; after that no member can record
anything, its own revoke included (issue #2864). The remedy is a new mesh, done as in the user guide ("Start over in a
new mesh"); a machine that cannot reach any member drops the old mesh the same way, since that step is local.

**A relay is down.** Nodes keep working through their other relays; dials race every relay, so no action is needed for
running meshes. New installs need the download relay (the Worker). Check `/healthz` on each relay and, for the Worker,
`node scripts/smoke.ts`. A node with only the failed relay reconnects on its own when it returns.

**The login service is down.** Existing meshes and invites keep working; only Google sign-in for new machines fails.
