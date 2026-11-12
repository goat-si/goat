# pen-relay

The Pen relay: one Cloudflare Worker and one SQLite-backed Durable Object per node, using the
WebSocket Hibernation API. It forwards sealed Noise records between a node's uplink and its clients
under `packages/pen-protocol/CONTRACT.md`.

## Dev

`pnpm run dev` starts `wrangler dev` on this directory. The timeouts default to the contract's values;
`wrangler dev --var AUTH_TIMEOUT_MS:300` (also `PENDING_TIMEOUT_MS`, `IDLE_TIMEOUT_MS`) lowers one for
testing, never above its default.

## Test

`pnpm test` runs the contract suite: each describe block starts its own `wrangler dev` in a process
group and drives it with fake nodes and clients over a small raw WebSocket client, which can send close
codes a browser WebSocket refuses and reports a close code as soon as the close frame arrives. Under
`wrangler dev` the ProxyWorker in front of the Worker negotiates `permessage-deflate` itself, so the
compression check runs in `scripts/smoke.ts` against the deployed Worker.

## Deploy

`pnpm run deploy` is the only supported way to publish (to workers.dev on the account in `wrangler.jsonc`;
log in with `wrangler login` first): it runs `scripts/check-public.ts`, which refuses a test build of
`public/install.sh` and a release whose four archives are missing or do not match `SHA256SUMS`, and a plain
`wrangler deploy` skips that. `public/dl/` is gitignored, so in a fresh checkout run
`apps/pen/scripts/build.sh <version> <relays>` first (docs/operations/pen.md, "Release the node").
Then run `node scripts/smoke.ts <url>`: it checks `/healthz` and that the
101 carries no `Sec-WebSocket-Extensions` when the dialer offers none (Pen dialers never offer compression;
the static-asset router accepts it from clients that do), moves 1 MiB each way between a fresh node and a client with
SHA-256 comparison, and prints close latency.

## What the relay sees

The relay never decrypts and never logs payloads, and Worker observability is off. It does see which
node ids accept uplinks, which addresses open client sessions to them and when, and the size and
timing of every record it forwards. It cannot read, forge, replay or splice records, because the Noise
layer authenticates both ends.

The Durable Object of each node id listed in the `TRAFFIC_NODES` secret keeps one `traffic` row: bytes
toward the node and from it and session counts, written at most once a minute and never an address.
Listing and reading are in the [runbook](../../docs/operations/pen.md#relay-traffic).
