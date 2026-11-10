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

`pen relay check <url>` checks a relay end to end: `/healthz`, the certificate's expiry, and a throwaway node that
uplinks and exchanges 64 KiB each way with a client through the relay, with timings. It exits 1 on any failure,
including a certificate that expires within 14 days (`--min-cert-days`), so it works as a cron or monitor probe. Run it
against both relays after every deploy:

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
`install.sh`), which is gitignored and published by the next `pen-relay` deploy. Older `dl/<version>/` folders stay
and keep being served; an `install.sh` downloads the version it was built for unless `PEN_VERSION` names another.
Upgrade a running node by replacing its
`~/.local/bin/pen` (or rerunning `install.sh`) and restarting it with `pen down` and `pen up`.

## pen-relay Worker

Deploy: in `infra/pen-relay`, `pnpm run deploy` (after a `build.sh`, or the deploy publishes whatever `public/`
holds). Then `node scripts/smoke.ts https://pen-relay.pos090001.workers.dev`: it checks `/healthz`, that the upgrade
offers no compression, moves 1 MiB each way between a fresh node and a client, and prints close latency. Check one
served build with `curl -fsS .../dl/<version>/SHA256SUMS` against the local file.

Rollback: `pnpm exec wrangler deployments list`, then `pnpm exec wrangler rollback <version-id>`. Static assets roll
back with the version. Its Durable Objects keep nothing that outlives their sockets, so a rollback loses only open
sockets, which reconnect.

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

Rotate the Google client secret: create a new secret in the Google Cloud console, update the client file, run
`deploy:secrets` again. Sign-ins in flight fail once; nothing else changes.

Moving the service or recovering a deleted Worker: `deploy:secrets` with `--signing-key-file` pointing at the kept
file restores the same key, and bound meshes notice nothing.

Rotate, or replace a lost or leaked `LOGIN_SIGNING_KEY`: delete the secret
(`pnpm exec wrangler secret delete LOGIN_SIGNING_KEY`), run `deploy:secrets` with `--signing-key-file` naming a new
file, and ask each person to run `pen login` on one member of their mesh, which binds the mesh to the new key. Until
then new machines cannot sign in to those meshes; members and invites keep working. There is no overlap period:
assertions live 10 minutes and members check them only against the key their mesh is bound to.

## Seoul relay

The VM (`clisu-oracle`, Ubuntu on arm64) runs `/opt/pen-relay/pen relay serve` under the system unit
`apps/pen/install/pen-relay.service`, installed as `/etc/systemd/system/pen-relay.service`. It runs as a dynamic
user with a read-only system, no access to home directories and a 512 MiB memory ceiling
(`systemd-analyze security pen-relay` rates it 1.6). `/etc/pen-relay.env` sets `PEN_RELAY_LISTEN=10.0.0.222:443`
(the VCN's private address behind the public `158.180.76.7`) and `PEN_RELAY_HOST=158-180-76-7.sslip.io`. The
Let's Encrypt account and certificate are cached in `/var/lib/pen-relay/acme` (systemd keeps it in
`/var/lib/private/pen-relay`).

Install on a new VM: put the binary at `/opt/pen-relay/pen` (0755), write `/etc/pen-relay.env`, copy the unit file,
then `sudo systemctl daemon-reload && sudo systemctl enable --now pen-relay`. To keep an existing certificate, copy its
cache into `/var/lib/private/pen-relay/acme` before the first start; systemd hands it to the service user.

Deploy a new binary: copy `pen-linux-arm64` from the build (gunzip it) to the VM, `sudo cp /opt/pen-relay/pen
/opt/pen-relay/pen.prev`, `sudo install -m 0755 <new> /opt/pen-relay/pen`, `sudo systemctl restart pen-relay`, then
`pen relay check https://158-180-76-7.sslip.io`. Rollback installs `pen.prev` the same way. Logs:
`journalctl -u pen-relay`; TLS handshake errors from scanners are normal there.

Certificates: `autocert` renews a certificate when a third of its lifetime is left (30 days for Let's Encrypt's
90-day certificates, with up to an hour of jitter) while the process runs, and a restart reuses the cached certificate
(the 2026-11-10 move to this unit kept serial `051E01E7…E463`). A failed renewal is retried every 30 to 60 minutes and
is not logged; the relay keeps serving the cached certificate until it expires, and after that every TLS handshake
fails until issuance succeeds. A failed first issuance does the same and the process keeps running. So the alarm is
`pen relay check`, which fails 14 days before expiry. Issuance needs port 443 reachable from the internet
(TLS-ALPN-01); restarting the service retries at once.

## Incidents

**A member was lost or stolen.** On any other member: `pen revoke <member> --compromised`, then `pen lock on`. If the
mesh is bound to a Google account, change that account's password and reset its machine list from the reset link on
`https://pen-login.pos090001.workers.dev/device`. Every member refuses the revoked key as soon as the revoke reaches it,
so push it to every member (`pen ls` shows who is online).

**A relay is down.** Nodes keep working through their other relays; dials race every relay, so no action is needed for
running meshes. New installs need the download relay (the Worker). Check `/healthz` on each relay and, for the Worker,
`node scripts/smoke.ts`. A node with only the failed relay reconnects on its own when it returns.

**The login service is down.** Existing meshes and invites keep working; only Google sign-in for new machines fails.
