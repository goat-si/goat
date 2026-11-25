# Product analytics

The server owns analytics delivery, consent, and identity for every connected client.
Clients do not load an analytics SDK. Client-use events require an
authenticated connection, so visiting the hosted app without connecting does not
count as product use.

## Consent

Nothing is recorded or sent until a person says yes. The server's `telemetryConsent` setting
starts `undecided`, which sends nothing, exactly like `declined`; existing installs decode to
`undecided` too, so an update never turns sharing on. It is classified `person` in
`SETTINGS_ACCESS`: an agent must not answer for the person it describes.
`GOAT_TELEMETRY_ENABLED` overrides the setting either way for headless servers. The legacy
upstream variable can only turn sharing off, and its "off" outranks `GOAT_TELEMETRY_ENABLED`, since a
leftover upstream opt-in is not consent to GOAT.

[AnalyticsService](../../apps/server/src/telemetry/AnalyticsService.ts) reads consent on every
record and send, so turning it off stops delivery at once. It also follows settings changes: saving
any answer but `granted` drops queued and failed batches, and declining deletes the install id,
so sharing again starts fresh. While settings changes are pending, analytics pauses delivery and
drops new events. GOAT Connect relay tracing needs
`GOAT_TELEMETRY_ENABLED=true` explicitly.

## Installs and owners

`distinct_id` and `installId` are the same value: the hash of a random id in the state
directory, created by the first event after consent. If that file cannot be written, nothing is
sent, so an install never reports under a changing id. Builds before consent used a hashed Codex
workspace or Claude machine id as `distinct_id`; histories from those builds do not join to new
installs.

Never derive an id from provider login or config files such as `~/.codex/auth.json` or
`~/.claude.json`. They belong to the provider, and reading them to identify people is what the
upstream project was criticized for. Who an install belongs to is sent as `install.owner_observed`, from
[two sources](../../apps/server/src/telemetry/Identify.ts): the GOAT Connect account (read by the
server from its linked account, and reported by a connecting client) and the client device's own
random id. Owners are resolved at query time in our own store, so a rule can change and apply to
all history. Two Connect accounts are never the same person.

Every id is SHA-256 hashed with [one helper](../../packages/shared/src/telemetryId.ts)
on both sides, so a Connect account hashes the same on the client and the server.
The server accepts only hashes from clients.

## Attribution boundaries

Client dimensions belong to the event's WebSocket connection. A server-global
"current client" would misattribute simultaneous web, desktop, and mobile use.
Provider execution has its own events because a turn can outlive the requesting
connection.

Keep client and server dimensions separate. A desktop host can serve a phone or a
remote browser, and a direct connection can cross a network. Older clients omit
metadata. Missing client values must stay unknown rather than being backfilled
from server properties. The legacy `clientType` property describes how the server
runs; use `surface` for the connected client.

## Interpreting events

Use `client.turn.requested` for active-use reports. There is no connection event,
because GOAT Connect sessions expire hourly and each reconnect would count again.
A command whose id was already accepted is a retry, so it records nothing again.
One identity can appear in several client groups during a period; adding those
groups double-counts users.

Provider send and completion counts need not match. Most completions start
without a person: provider continuations, agent sends, and delegated subagents.
`provider.turn.completed` carries the starting message's `createdBy` and
`creationSource`, plus `scheduled` and `subagent`; filter on them to count user
turns. Collection is best effort, with no scan or backfill of provider history.

Token totals cover the main agent. Child agents and model rerouting prevent a turn
from representing one provider/model combination's full cost. For provider
comparisons, require complete usage, no observed subagents, and no mixed models;
compare matching model, effort, interaction mode, and terminal status. Aggregate
output/input ratios should divide the summed totals. Averaging per-turn ratios
lets small-input turns dominate.

Unknown counts stay absent. Partial usage contains valid observed counts but
cannot establish a whole-turn total. Keep these distinctions when changing token
normalization or building reports.

`feature.used` counts WebSocket requests that start a feature. RPCs are observed in
the RPC authorization middleware after the request succeeds; dispatched commands
are recorded by the dispatch handler, which can tell a retry apart.
[Feature mapping](../../apps/server/src/telemetry/FeatureUsage.ts) allowlists
the methods and commands, and takes variants only from closed contract enums,
so paths, ids, and text never reach analytics. Guests of a shared thread have no
WebSocket connection, so the guest share service records their joins and messages
itself, with no `surface`.

Agent tool events report driver kinds, never instance ids: users name
instances, so an instance id can identify an account or employer.
[Provider dimensions](../../apps/server/src/telemetry/ProviderDimensions.ts)
report a model only when it is a non-custom entry in a vendor catalog. OpenCode,
Pi, and ACP agents list models from user configuration, such as local Ollama
tags, so their models stay out. Handoff settings come from closed enums and
booleans in tool arguments; prompts, titles, and ids are never read. Thread ids
are used only to look up the threads on each side and never leave the server,
which is also why tool events carry no per-thread sequence. A handoff to several
threads, such as `create_threads`, records one `mcp.tool.invoked` per target, each
repeating the call's outcome and duration, so event counts are not call counts.

## Delivery

The server sends PostHog-format batches to GOAT's ingest Worker at `ingest.trygoat.ai`
([infra/ingest](../../infra/ingest/README.md)), which stores them in GOAT's Cloudflare D1
and forwards nothing. Builds before it sent to the upstream project's `ingest.t3.codes`, and keep
doing so until they update. A send can fail after the ingest has stored the batch, so
every retry is a copy; the ingest stores an identical retry once per UTC day, and the
event uuid identifies copies across days.
[Delivery](../../apps/server/src/telemetry/AnalyticsService.ts) gives each event a
uuid when it is recorded (the endpoint rejects events without one), backs off after
a failed send, and drops a batch after a few tries. Without these limits, one stuck
batch was sent every second for days. The ingest answers 400, 401 and 413 only for a
batch it can never accept, which the server drops, and 429 or 503 when it is busy or
full, which the server retries.

## Collection boundary

Keep analytics payloads to product metadata and normalized measurements. Do not
send prompts, authentication material, raw provider payloads, user-assigned device
names, or conversation identifiers. Client metadata is best effort; invalid values
must not reject a connection.

The ingest enforces this boundary a second time: it stores only the events and
properties in [the allowlist](../../packages/shared/src/analyticsAllowlist.ts), as flat
booleans, numbers, and short strings, and drops everything else. A new event or
property reaches storage only after it is reviewed into that list and the Worker is
redeployed. The server also sends PostHog's `$process_person_profile: false` for anyone
who points `GOAT_POSTHOG_HOST` at PostHog; GOAT's ingest drops it.

Dev-runner servers and the CI archive smoke test turn telemetry off, which also
stops relay tracing, because each would count as a new install. Set
`GOAT_TELEMETRY_ENABLED=true` to test analytics or relay tracing from a dev server.
