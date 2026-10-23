# Server updates

A [stable launcher](../../apps/server/src/serviceLauncher.ts) owns the runtime
selected by systemd or launchd. It is the only runtime writer of durable service
state. Server children request updates over inherited IPC; they never rewrite
their service definition or select their own replacement. Local service commands
may replace the launcher and state while the service is stopped. Foreground CLI
processes do not self-update.

This page covers one replacement. The policy above it (independent app and server
updates, protocol ranges, who may update, and auditing) is in
[remote updates](./remote-updates.md).

Exact-version installs keep restarts independent of npm cache eviction or a moving
release tag. Installation and preflight happen in staging before publishing an
immutable runtime. Preflight checks the launcher protocol because a target that
needs new rollback guarantees cannot safely run under an older launcher. Upgrading
that launcher requires a local service update.
Each install records the verified archive digest and the executable's SHA-256 in
`.install-record`. A server update, which runs the cached build unattended,
reuses an install only while its executable still matches and otherwise installs again
from the release with `SHA256SUMS`.

Boot-service updates without `confirmReplacement: true` refuse while the server is
busy. This includes older clients that omit the field. Admission closes and idle is
checked again after staging; thread continuation is recovery intent, not consent to
interrupt work. Desktop-managed requests retain the app updater's existing behavior.

Before launcher handoff, the server fsyncs a requester record to
`<userdata>/maintenance-audit.jsonl`. SSH update requests use the same journal on
the requesting server. The file stays outside SQLite rollback. Launcher acceptance
is recorded when possible; acceptance does not mean the trial committed.

## Commit boundary

The launcher durably records the pending update before acknowledging it, then
stops the old child and starts the target as a trial. Service-state writes use
same-directory replacement with file and directory fsync. Invalid state stops
startup rather than guessing which runtime to boot.

The trial must finish migrations, acquire dependencies, bind HTTP, and park every
long-running root at the activation gate before reporting `prepared` with the bound
HTTP host and port. The descriptor route already serves while those roots are parked:
`routesReady` is part of the prepared barrier, and metadata does not wait for
activation. The launcher probes `/.well-known/goat/environment` on the bound address
(loopback of the same family for a wildcard listener, IPv4 loopback when a trial reports no
host) with a 30-second deadline covering connection through the complete JSON body. It
requires HTTP 200, the exact target `serverVersion`, and valid SSH and orchestration
ranges using the shared protocol comparator. The launcher's own older protocol
versions do not constrain the ranges the new build may serve.

After a successful probe the launcher commits the target version durably and
replies `committed`. Only then may the
child release its gates, accept commands, and publish ready. Keep fallible startup
acquisitions before this boundary. A listener alone does not prove the runtime is
ready to commit.

A failed or timed-out trial returns to the old version; a failed probe records
`rolled-back` with `smoke-failed:<category>`. An older trial without a port skips
the probe with a launcher log and still receives probation. These optional fields
keep launcher protocol 3: older decoders ignore the port and new decoders accept
its absence. A surviving older launcher cannot supply the new health guarantees
until a local service update replaces it.

For ten minutes after commit, the target is on probation and the database snapshot
stays available. Any child exit, including exit code zero or a signal, rolls back
with `probation-exit:<code-or-signal>`, except an explicit service stop, a stop
marker, or the state-directory-owned idle path. Another update is refused during
probation so there is only one rollback snapshot. The deadline and database path
are persisted in service state; a launcher restart retains the original deadline.
A restarted launcher that cannot start the target during probation rolls back with
`probation-start-failed` instead of failing to the service manager, whose restarts
could otherwise outlast the deadline and discard the snapshot.
Expiry durably clears probation and discards the snapshot. After that, an unexpected
active exit fails the launcher so the service manager's ordinary restart policy
applies.

The prepared deadline is long because migrations can scale with the database
and block the trial's main thread, so it cannot report progress. A missed
deadline restores the snapshot, and the retry pays the same cost again. A
crashed trial is caught when it exits; the deadline bounds only a stuck one.
Client update waits must outlast the deadline, or a slow update shows as failed.

## Database rollback

Before stopping the old child, the launcher refuses an update whose snapshot will
not fit on disk, so a full disk does not cause an outage. After the old child
exits, the launcher snapshots SQLite's main file, WAL, and shared-memory file. This makes trial migrations reversible without down
migrations. The snapshot is made once per update and survives launcher restarts;
replacing it during a retry could capture changes from the failed trial.

Another server can share the same userdata, for example a desktop app whose
home the service also uses. Every server holds `server-owner.lock` for its
lifetime, and each acquisition appends its owner to a generation log in that
file. The launcher copies only while it holds the lock, so a busy lock fails the
update with `db-owner-busy` before anything is copied, and it records the
generation with the snapshot. Before restoring, it reads every owner since that
generation. If any is not this update's launcher, its trial
(`service-trial:<updateId>`), or the target restarted during its probation
(`service-probation:<updateId>`), the snapshot is kept and the reason gains
`;db-kept-for-other-server`, because restoring would erase that server's writes.
A rollback that finds the lock busy stays pending and retries, across launcher
restarts too. Servers older than the lock do not record themselves, so they stay
invisible to this check.

Rollback stops the trial before restoring. A probation rollback first durably
records its reason, so recovery still finishes that rollback if ownership stays
busy beyond the probation deadline. A durable restore marker makes an interrupted
restore finish before either version boots. Keep the snapshot until probation
expires, or until both restoration and the terminal rollback state are durable.
The owner-log rule also applies after launcher restarts. A target the launcher restarts
while its update is on probation records `service-probation:<updateId>`, so a probation
rollback still restores the snapshot; any other server's writes keep it.
Attachments and other files outside SQLite are outside this rollback boundary.

## Client acknowledgement

An accepted update is still pending. Clients correlate the launcher's update ID
with the ready event after reconnecting, then check the outcome and target version.
A reconnect alone cannot distinguish successful replacement from rollback. Older
servers without an update ID retain version-only correlation.

Desktop updates have a separate two-phase handoff because installing the app stops
its bundled backend. Preparation returns a token while the connection is alive;
the client commits that token only after receiving it. Otherwise backend shutdown
could lose the only successful RPC result. The client must then observe the
prepared version after reconnecting. If installation fails, desktop restarts the
stopped backends and replays the failure for the same token.

## Recovering interrupted threads

Restart continuation is an environment-owned preference, on by default. A
`settings.json` that fails to decode turns it off, since the file may hold an
opt-out. The
[v2 recovery service](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
requires matching durable run, provider thread, session, and native resume identity.
Queued runs never started, so recovery holds them and continues the run they wait
behind. A settled run qualifies only when the restart cancels work the agent waits on
(a monitor, subagent, or background task) and its session was live, so stale records
from an older crash never wake it. Its continuation prompt is the note of what will not
report back. A shell alone does not wake a settled run: most are dev servers nobody
waits on, so that note waits for the next user message.

Recovery retires effects tied to the lost process and records continuation intent
in the durable outbox. That intent survives another restart before provider startup.
Continuation effects wait for activation; a slow provider must not delay the server's
readiness or the launcher's commit boundary. Graceful shutdown captures intent before
closing providers, then reconciles after ingestion has stopped so a late completion
cannot be overwritten by a stale cancellation.

The [continuation handler](../../apps/server/src/orchestration-v2/RestartContinuation.ts)
rechecks the preference, provider selection, newer user work, a stop the user requested,
and maintenance turns such as `/compact` before dispatching. Intent and delivery both
refuse a thread that is archived, settled, or still snoozed, a cut turn whose provider
turn already ended, and a run waiting on the user: an approval, question, or secret that was pending,
or that recovery closed on the cut turn. Message-capable questions stay answerable, so
they do not block. Delivery also stops after three consecutive continuations in one
`restartContinuationOfRunId` chain, so a turn that crashes the server cannot loop. Stable
command and message IDs prevent duplicate submissions after an outbox retry. Codex
resumes without adding provider prompt text unless the turn lost background work;
other adapters receive the continuation message through their normal turn path.

Delegated tasks (`goat_task_create` child threads) are reconciled as their own threads,
never as the parent's background work. The orchestrator settles child results and
completion deliveries in a startup pass after reconciliation, because the terminal-run
listener ignores reconciliation's cancellations. A cancelled child whose restart
continuation is still pending in the outbox is not a result yet; the continuation's run
settles it, or the handler settles it when it declines to continue. Schedulers wait for
activation so they cannot start runs that reconciliation would then cancel.
