# GOAT ingest

The Cloudflare Worker at `https://ingest.trygoat.ai` that stores GOAT's product analytics. The
GOAT server sends PostHog-format batches to `/batch/`
([AnalyticsService](../../apps/server/src/telemetry/AnalyticsService.ts)); what the events contain
is described in [product analytics](../../docs/internals/product-analytics.md) and, for users, in
[Product usage data](../../docs/user/telemetry.md).

## What it stores

- Only the events and properties in
  [the allowlist](../../packages/shared/src/analyticsAllowlist.ts), as booleans, finite numbers and
  strings of at most 256 characters. Unknown events, unknown properties, nested values and every
  other field of the request are dropped without being read further.
- One D1 row per accepted batch: the UTC day it arrived, a SHA-256 of the stored JSON, the event
  count and the events. Values every event of a batch shares are stored once.
- No IP address, user agent, location or other request metadata. The client address is used only
  as the rate limiter's key, and Worker logs are off. Cloudflare's edge still sees the connection,
  as for any HTTPS service.
- Nothing is forwarded to another service.

Retention deletes each row 178 to 179 days after it arrived (cleanup runs every 6 hours), so data is
gone from the table within 180 days. D1 Time Travel can restore deleted rows for 7 days on the Free
plan (30 on Workers Paid) after that.

## Limits

| Limit                       | Value                                            | Answer |
| --------------------------- | ------------------------------------------------ | ------ |
| Body                        | 128 KiB                                          | 413    |
| Events per batch            | 100                                              | 413    |
| Wrong or missing `api_key`  | `ACCEPTED_KEYS`                                  | 401    |
| Requests per client address | 60 a minute, per Cloudflare location             | 429    |
| Batches per UTC day         | `DAILY_BATCH_BUDGET` (20,000)                    | 503    |
| Storage cost per UTC day    | `DAILY_BYTE_BUDGET` (2.4 MB of `rowStorageCost`) | 503    |
| Database size               | D1's limit (500 MB Free)                         | 503    |

The server drops a batch answered 400, 401 or 413 and retries 429 and 503 with backoff. The daily
storage budget times 180 days stays under the Free plan's 500 MB per database, because
`rowStorageCost` charges each row for SQLite's worst page occupancy. That allows about 1,700
single-event batches a day, or about 235 typical 20-event batches (6.5 KB stored each, about
4,700 events). If real traffic needs more, move the account to Workers Paid (10 GB per database)
and raise `DAILY_BYTE_BUDGET`. Each batch costs two D1 row writes, so the batch budget leaves
more than half of the Free plan's 100,000 daily writes for retention.

The endpoint is public and unauthenticated by design: the key is public. Anyone can spend a day's
budget, after which genuine batches are refused until 00:00 UTC; the server retries and then drops
them. If the database reaches D1's size limit, writes are refused until retention frees pages, which
later inserts reuse.

## Deploy

Run from this directory with Wrangler logged in to the Cloudflare account that owns the
`trygoat.ai` zone. Apply migrations before deploying code that needs them.

```sh
vp run migrate
vp run deploy
pnpm dlx wrangler@4.152.0 d1 execute goat-ingest --remote --command "PRAGMA page_size"
```

`rowStorageCost` assumes 4096-byte pages; the last command must print 4096. To add an event or
property, update the allowlist, run this package's tests, and redeploy before releasing the server
change; until then the ingest drops it.

Counts without reading content:

```sh
pnpm dlx wrangler@4.152.0 d1 execute goat-ingest --remote \
  --command "SELECT received_day, COUNT(*) AS batches, SUM(event_count) AS events FROM batches GROUP BY received_day"
```
