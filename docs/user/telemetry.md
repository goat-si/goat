# Product usage data

The GOAT server sends product usage events to GOAT's own endpoint at `ingest.trygoat.ai`,
associated with a hashed account or installation identifier. To count how many installations one person
uses, the server also sends hashed account identifiers: your GOAT Connect account, your OpenAI and
Claude accounts when you are signed in, and a random identifier for each device that connects.
Events include the provider, model, reasoning effort, permission mode, turn result, duration,
release channel, and main-agent token totals when available.

The endpoint runs on Cloudflare and stores events in GOAT's own database. It keeps only the events
and fields GOAT has reviewed for collection and drops anything else. It does not store your IP
address, user agent, or location, and it forwards nothing to other services. Each event is deleted
within 180 days; deleted data can remain in the database's point-in-time recovery for up to 30 days
after that. If cleanup is down for more than about a day, deletion waits for it to recover.

GOAT builds released before this endpoint existed send these events to the endpoint of the project GOAT was forked from, at
`ingest.t3.codes`, which forwards them to PostHog, until you update.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

GOAT also sends relay connection traces to Axiom to diagnose GOAT Connect connectivity.

To disable product events and relay tracing, set `GOAT_TELEMETRY_ENABLED=false` in the server's
environment before starting it. Relay tracing also stops when `GOAT_OTEL_SDK_DISABLED` or
`OTEL_SDK_DISABLED` turns OpenTelemetry export off. The web app in a browser, including one the
`goat` CLI opens, does not read these variables.

The desktop app reads `GOAT_TELEMETRY_ENABLED` from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > General > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`GOAT_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `GOAT_OTLP_*_URL`, set `GOAT_OTLP_HEADERS` for
receivers that need authentication and `GOAT_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
