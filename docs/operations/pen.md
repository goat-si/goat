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
None can be read back from Cloudflare.

Deploy: in `infra/pen-login`, `pnpm run deploy:secrets <google-oauth-client.json>` sets the Google secrets and deploys
in one version; it creates `LOGIN_SIGNING_KEY` only when the Worker has none. A code-only change uses
`pnpm run deploy`. Check `GET /v1/keys`: its `kid` must not change across deploys, because every bound mesh pins it.
`GET /` answers 303 to `/device`.

Rollback: as for pen-relay. The `Login` Durable Object holds the account registry, device codes and rate-limit
counters in SQLite; a rollback keeps that data, so roll back only to a version whose schema reads it.

Rotate the Google client secret: create a new secret in the Google Cloud console, update the client file, run
`deploy:secrets` again. Sign-ins in flight fail once; nothing else changes.

Lost or leaked `LOGIN_SIGNING_KEY`: delete the secret (`pnpm exec wrangler secret delete LOGIN_SIGNING_KEY`), run
`deploy:secrets` to create a new one, and ask each person to run `pen login` on one member of their mesh, which binds
the mesh to the new key. Until then new machines cannot sign in to those meshes; members and invites keep working.

## Seoul relay

The VM runs `pen relay serve` as user `ubuntu` from `/home/ubuntu/pen-relay/pen` under the system unit
`pen-relay.service`, listening on `10.0.0.222:443` behind the VCN's public address `158.180.76.7`, with a Let's
Encrypt certificate for `158-180-76-7.sslip.io` cached in `/home/ubuntu/pen-relay/acme`.

Deploy a new binary: copy `pen-linux-arm64` from the build (gunzip it) to the VM, keep the running one as
`pen.prev`, move the new one into place and `sudo systemctl restart pen-relay`. Rollback is the reverse. Check
`https://158-180-76-7.sslip.io/healthz` and `journalctl -u pen-relay -n 50`.

Certificates: `autocert` renews a certificate when a third of its lifetime is left (30 days for Let's Encrypt's 90-day
certificates, with up to an hour of jitter) while the process runs, and a restart reuses the cached certificate. A
failed renewal is retried every 30 to 60 minutes and is not
logged, and the relay keeps serving the cached certificate until it expires; after that every TLS handshake fails until
issuance succeeds. Watch the expiry with
`echo | openssl s_client -connect 158.180.76.7:443 -servername 158-180-76-7.sslip.io 2>/dev/null | openssl x509 -noout -enddate`.
Issuance needs port 443 reachable from the internet (TLS-ALPN-01).

## Incidents

**A member was lost or stolen.** On any other member: `pen revoke <member> --compromised`, then `pen lock on`. If the
mesh is bound to a Google account, change that account's password and reset its machine list from the reset link on
`https://pen-login.pos090001.workers.dev/device`. Every member refuses the revoked key as soon as the revoke reaches it,
so push it to every member (`pen ls` shows who is online).

**A relay is down.** Nodes keep working through their other relays; dials race every relay, so no action is needed for
running meshes. New installs need the download relay (the Worker). Check `/healthz` on each relay and, for the Worker,
`node scripts/smoke.ts`. A node with only the failed relay reconnects on its own when it returns.

**The login service is down.** Existing meshes and invites keep working; only Google sign-in for new machines fails.
