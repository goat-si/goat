# Product usage data

GOAT sends no product usage data until you turn it on. A new or updated GOAT server sends nothing
while you have not chosen, and nothing after you choose not to share.

## What is sent when sharing is on

The GOAT server sends events to GOAT's own endpoint at `ingest.trygoat.ai`. Every event carries a
random identifier created for this installation when you turn sharing on (sent hashed), the GOAT
version and release channel, and the server's operating system and processor type. These are the
events:

- **Server start**: the number of threads and projects.
- **Turn finished**: the provider, model, reasoning effort, permission and interaction mode, result,
  duration, and main-agent token counts. A model is named only when it appears in a provider's
  public model list; custom and local models are left out.
- **Client use**: when a thread is started or a message sent, the kind of client (web, desktop or
  mobile), its version, operating system, browser, device type and model, and how it connected.
- **Feature use**: which feature a request started, from a fixed list.
- **Agent tools**: which GOAT tool an agent called, the calling and target provider and model, the
  outcome and duration.
- **ChatGPT sign-in**: whether a sign-in or profile transfer completed, how long it took, and how
  many accounts are connected.
- **Ownership**: the hashed GOAT Connect account and the hashed random device identifier of each
  client that connects, so one person's installations can be counted together.

Events never include prompts, responses, file contents, file paths, project or thread names,
credentials or tokens, conversation IDs, raw provider events, child-agent output, or device names.
GOAT never reads Codex, Claude, or other provider login files to identify you.

The endpoint runs on Cloudflare and stores events in GOAT's own database. It keeps only the events
and fields GOAT has reviewed for collection and drops anything else. It does not store your IP
address, user agent, or location, and it forwards nothing to other services. Each event is deleted
within 180 days; deleted data can remain in the database's point-in-time recovery for up to 30 days
after that. If cleanup is down for more than about a day, deletion waits for it to recover.

## Turn sharing on or off

Set `GOAT_TELEMETRY_ENABLED=true` in the server's environment before starting it to share, or
`GOAT_TELEMETRY_ENABLED=false` to keep sharing off whatever is chosen elsewhere. The desktop app
reads the variable from your shell profile (for example `~/.zshrc`) on macOS and Linux, so export it
there and restart the app. On Windows, set it as a user environment variable. A browser or mobile
client does not read the server's environment variables.

Turning sharing off stops it at once: events waiting to be sent are dropped. Choosing not to share
also deletes the installation's random identifier, so sharing again later starts with a new one.
Turning sharing off does not stop OpenTelemetry exports to your own receiver.

GOAT builds released before this change shared usage data by default. Builds released before
GOAT's own endpoint existed send these events to the endpoint of the project GOAT was forked from,
at `ingest.t3.codes`, which forwards them to PostHog, until you update.

## Mobile diagnostics

In the mobile app, **Settings > Diagnostics** lets you copy a startup crash report or a thread
stream report. The reports stay on the device until you share them. A crash report can include an
error message and component stack; the message can quote a value the app was handling. Review it
before sharing.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > General > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
These exports are separate from product usage events and can include diagnostic information about the server and connected web or desktop
client. Error messages may contain values being handled by the app. Set `GOAT_OTEL_SDK_DISABLED=true`
(or `OTEL_SDK_DISABLED=true` when `GOAT_OTEL_SDK_DISABLED` is unset) in the server environment to
disable OpenTelemetry exports, including endpoints configured here; restart the server after changing
environment variables.
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
