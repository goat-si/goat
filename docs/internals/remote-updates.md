# Remote updates

This page records how GOAT updates servers it does not run in-process, who may ask
for that, and how clients and servers of different versions work together. The
mechanics of one replacement live in [server updates](./server-updates.md) and
[SSH replacement](../../structure/ssh.md#replacement); this page is the policy
above them.

## The problem

A desktop app is not always able to update itself. The bundle may sit in an
`/Applications` folder the user cannot write, an organization may manage it, it
may run translocated from a download, or the machine may simply be closed in a bag.
Meanwhile the servers it talks to keep running agents: the SSH runtime under
`~/.goat/runtime`, a `goat service` install, or another machine's server. Those
must not be frozen at the app's version, and an app that did update must keep
working with servers that did not.

## Decision

App and server update independently. Compatibility is decided by the protocol
range a server advertises and by individual capabilities, never by release
versions. Every update targets one exact, verified build, moves a server only
when a person, an agent with the grant, the owning client's idle refresh, or
the server's enabled auto-update scheduler asks for it. It waits for idle unless a
person confirmed otherwise and records who asked.

Concretely:

1. **Servers update without the app.** The SSH runtime and `goat service`
   installs live in user-writable storage and have their own update paths
   (launcher trial and commit, SSH drain and supervisor). An app that cannot
   install says why, names the fix, and keeps working with every server whose
   range still serves it. The server embedded in the desktop app follows the app;
   moving it under a launcher is a staged follow-up (see Migration).
2. **The owning client still refreshes its runtime.** A client that launches a
   host's SSH runtime moves it to the client's own release when it is idle, as
   [Upgrades](../../structure/ssh.md#upgrades) describes. That is how a fleet
   follows the newest app without anyone visiting each host, and it never
   downgrades a newer runtime or replaces one it does not own.
3. **One exact build, verified.** Runtime supply stays exact-version: bundle,
   cache, mirror, public release, then `gh`. When the exact archive is
   unavailable, the host keeps a compatible runtime it already has and reports
   that. It may move to a newer installed runtime only when GOAT itself recorded
   and verified that install. Launcher-managed servers also resolve their own
   channel's newest release under the staged auto-update policy below; installation
   still names one exact build.
4. **Ranges, not versions.** A client speaks one orchestration protocol. A server
   serves a range and advertises it. The client connects when the range includes
   its protocol; otherwise exactly one side is named as the one to update.
5. **Permissions are checked at execution** through existing scopes or a thread’s
   goatclaw profile for host preparation. Disruption is gated by idleness or an
   explicit human confirmation, and every update request is journaled with its actor.

## Options considered

Three positions were argued against each other, with a fourth reviewer attacking
all of them for security, and a judge writing the verdict.

- **Strict lockstep** (VS Code Remote-SSH, Zed, cmux): the server always matches
  the app, and the app pushes its own bundled runtime. It is simple and
  reproducible, and its exact, checksum-verified supply survives in the decision.
  It was rejected as the whole answer because a frozen app would freeze every
  server it manages, which is the problem we started from. GOAT also shares one
  server per host user across several clients of different versions, so "match
  the client" has no single answer.
- **Independent updates within a compatibility window** (Tailscale's capability
  version): app and server move independently; ranges and capabilities decide
  what works. Its compatibility model is the decision. Its proposal to pick the
  newest compatible runtime from any installed directory was rejected: a
  directory's existence and a binary's self-reported version prove neither
  provenance nor permission, and probing a planted directory executes it.
- **Server-led** (Tailscale auto-update, herdr's settings-driven updates): each
  server owns its channel, schedules its own updates, and tells clients to update.
  Destination ownership of the selected version and idle-only activation were
  kept. Launcher-managed stable and nightly servers now schedule their own idle
  updates under ADR-0019. Removing client archive uploads after bootstrap and
  moving client-launched SSH runtimes under the service launcher remain deferred.

The red team's findings that changed the design: a launcher-managed update
stopped running work without an idle check or confirmation; an installed-runtime
scan without install records turns any writable directory into code execution; a
cache archive without a sidecar is pushed as trusted; and no path recorded who
requested an update. Its findings of theatre were also accepted: making MCP
"read-only by default" while the same session holds shell authority protects
nothing, and a confirmation dialog without a server-side check is decoration.

Precedents that shaped specific rules:

| Precedent                      | What GOAT takes from it                                                                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VS Code Remote-SSH             | Server installed by the client over SSH when the host cannot download; unsupported hosts degrade with a banner rather than refusing.                                                                  |
| Zed remote                     | Versions side by side under one directory; delete only versions that are older and not in use.                                                                                                        |
| JetBrains Gateway              | A backend upgrade is an explicit action; old backends stay until removed.                                                                                                                             |
| Tailscale                      | Remote "update now" needs device-side consent, an online device, and an admin. Capability numbers let the control plane adapt instead of failing. Organization policy beats user settings.            |
| cmux                           | Release-pinned remote daemon verified by a SHA-256 manifest and a hello handshake; features gated on advertised capabilities.                                                                         |
| herdr / herdr-web-ui           | UI updates decoupled from the agent runtime, from Settings, without stopping agents. Its updater still refuses unwritable install directories.                                                        |
| Squirrel.Mac, Sparkle, VS Code | Detect read-only volumes, translocation, and unwritable bundles before trying, and give a typed reason. A ShipIt failure after quit never reaches the app, so success is the version that comes back. |

## Compatibility policy

- A client speaks exactly `ORCHESTRATION_PROTOCOL_VERSION`. A server serves
  `[ORCHESTRATION_PROTOCOL_MIN_SERVED, ORCHESTRATION_PROTOCOL_VERSION]` and
  advertises it in its descriptor's `protocol.orchestration`. The `/ws` upgrade,
  the HTTP orchestration header, the client's connection check, and the outdated
  host check all read that range. A server without a range serves its single
  integer; one without either speaks protocol 1. A malformed range fails closed.
- Lowering `ORCHESTRATION_PROTOCOL_MIN_SERVED` is a promise that the server
  still decodes, encodes, and behaves correctly for that older protocol, and it
  ships with tests against real older payloads. Nothing promises an N-1 window by
  calendar. Raising the minimum is a deliberate breaking release.
- The SSH helper protocol uses the same comparator
  (`compareRuntimeProtocols`); clients compare with their own single protocol.
- Host status (`goat_host_status`, Settings > Hosts) shows the same verdict as a
  `compatibility` of `compatible`, `incompatible` or `degraded` (the host does not
  report its ranges). Two builds that serve the same protocols show no warning,
  whatever their versions or channels.
- Inside a compatible range, features are gated individually by
  `capabilities`. A missing capability disables that action only.
- Verdicts map to one state each:

| Verdict                          | What the user sees                                                                                                  | Who acts              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------- |
| compatible                       | Normal use. An eligible newer server or app shows as an optional update.                                            | Nobody has to.        |
| update-required (server too old) | The connection is restricted to status and maintenance; Update server is offered when the server can update itself. | Server owner.         |
| client-too-old                   | "Update this app" with the reason the app cannot (when it cannot). The server is never downgraded.                  | App owner.            |
| unknown or malformed             | Compatibility cannot be established; no automatic replacement.                                                      | Owner of either side. |

An incompatible pair restricts the connection. It never forces an unattended
restart. Compatible updates are idle-only by default. Background services
auto-update unless their owner disables the setting; an immediate replacement
needs a person's confirmation bound to that environment and target.

## Runtime supply and selection

- **Exact target.** An update resolves one exact version. The SSH path targets the
  owning client's release; `goat update` and `server.updateServer` target the
  requested version. Automatic service updates resolve the newest release on the
  server's own channel. The launcher refuses anything that is not newer.
- **Supply order** starts on the host. For a published version (stable, nightly
  or preview) with no mirror configured, the host downloads the archive from the
  public release itself and verifies it against `SHA256SUMS`. If it cannot (no
  route, a proxy, a pruned release, a checksum mismatch), the client supplies it
  and uploads it over SSH: bundle (with a canonical SHA-256 sidecar), local
  cache, explicit mirror, public `goat-si/goat-releases` over HTTPS, then `gh`.
  Public and `gh` downloads are checked against `SHA256SUMS`. An archive
  without a sidecar is accepted only from the local cache, which only the user
  writes; that is the supported way to hand a source build to remote hosts
  (`node scripts/dev-runtime-archive.ts --version <server version> --output-dir
  <base dir>/runtime/archives`). Dev and PR builds are never published, so they
  skip the host download and go straight to the upload.
- **No release.** `goat-releases` publishes sparsely (the first nightly appeared
  in October 2026), and source builds never publish. When the exact archive is
  missing, a live compatible server stays attached; with nothing running, the
  host starts the newest compatible runtime that is either the retained one or one
  installed on the host. Recorded installs carry the archive and executable
  digests, and the executable is hashed before anything in that directory runs.
  A directory without a record qualifies only when its completion marker, binary
  and directory are not symlinks and its own binary reports its exact version
  and both protocols (#412). Each fallback logs `ssh.runtime.upgrade.skipped`
  with the reason.
- **Nothing on the host.** A host that has never run GOAT (no runtime installed,
  nothing running, no database under `~/.goat/userdata`) gets the newest published
  runtime that is compatible with the client, nightlies first, then stable. This
  is what makes dev builds and platforms without a bundled archive connect. Each
  release carries `goat-<version>-runtime.json` (and each archive a
  `goat-runtime.json`) with the protocol ranges the runtime serves and its
  capabilities, so the client rejects an incompatible release before moving
  90 MB; the manifest must match `SHA256SUMS`, which also covers the archive.
  goat-releases has no detached signatures, so the trust anchor is the same as
  for the exact archive: HTTPS to `goat-si/goat-releases` plus `SHA256SUMS`.
  After installing, the client re-probes and starts the runtime only if its own
  binary reports compatible protocols, a provable build order against the
  requested build, and lists `memory:read` among the scopes it can issue (#285).
  The version is held (`~/.goat/runtime/goat/held/<version>`) from before
  installation until its server is ready; launch starts it only after checking,
  under the host lock, that the host still has no database. Installed and
  retained-runtime recovery skip held versions, and any marker GOAT cannot read
  counts as held. A runtime that fails verification stays held as `rejected`, so
  no later connection starts it or downloads it again; deleting it instead would
  race other clients and runners. GOAT clients from before this change do not
  read holds, so on a shared host their recovery could still start a held
  version.
  An older fallback is labelled "Upgrade to <requested> deferred" and retried
  every 10 minutes like any other deferred refresh. The release index is cached
  for 10 minutes (2 after a failure, longer when GitHub's rate limit says so).
  - Releases published before manifests existed are offered only while their
    channel has no manifest release at all, and only the newest one; their
    compatibility is then proven only by the installed binary. Once a channel
    publishes a manifest, its older releases are never offered.
  - Hosts with GOAT data are excluded because an older build cannot be proven to
    read data a newer one wrote: unknown migrations only warn at startup. Those
    hosts keep the installed-runtime recovery above, or fail with one sentence
    and one action (update the app, check that github.com is reachable, or put
    the named archive in the local archive directory).
- **Retained older runtimes.** With nothing running, an owning client installs
  its own release even when `run-t3.sh` names an older compatible one; an older
  retained runtime wins only when the client's archive cannot be acquired, and
  then a recorded newer install beats it.
- **Cleanup** follows Zed after a successful SSH launch/attach under the replacement
  lock, outside installs, drains and rollback windows: delete only proven older,
  unused versions, preserving live, retained, requested and one rollback build, the
  proven-older build installed last. Keeping every build whose order against the others
  was unknown let dev hosts collect dozens of versions, so only order against the live
  build is required. Unknown ordering against the live build or incomplete process
  inspection preserves the directory. Victims are renamed into sibling trash directories
  before deletion; cleanup errors only log and never fail the connection.

### Where hosts get the runtime

The host downloads first and the client uploads only as a fallback, as VS Code
Remote-SSH does. An upload costs the client its whole uplink for the archive, while
a host usually reaches GitHub's CDN faster than a laptop can push to it. Measured
on 2026-10-20 against a fresh linux-arm64 host (`clisu-oracle`) from a Mac Studio
on a fast link, for nightly `0.1.0-nightly.20261019.194`:

| Path                                      | Connect to ready | Client bytes sent |
| ----------------------------------------- | ---------------- | ----------------- |
| Host download                             | 40.3 s           | 0                 |
| Host blocked by a dead proxy, then upload | 42.9 s           | 88 MiB            |
| Upload only (before this change)          | 42.0 s           | 88 MiB            |

The raw transfer takes about 3 s either way on that link; extraction and
verification on the host take most of the rest. A blocked host costs about 3 s
before the upload starts, because curl and wget retry only transient failures
(timeouts, 408, 429, 5xx) and a refused connection, missing DNS or a 404 fails at
once. With curl, a blackholed route waits out three 10 s connect attempts; wget
uses 30 s timeouts. A host download that times out or loses its connection fails
the attempt instead of uploading, because the host may still be installing. Proxies
come from the user's login shell (`https_proxy`), which the download runs under.

Archive sizes for that nightly, which also decide what the desktop bundles:

| Platform     | Archive  |
| ------------ | -------- |
| darwin-arm64 | 80.1 MiB |
| linux-x64    | 92.4 MiB |
| linux-arm64  | 88.4 MiB |
| win32-x64    | 83.8 MiB |
| win32-arm64  | 73.4 MiB |

There is no darwin-x64 archive: Node single executables crash on Intel Macs, so
those hosts get an `unsupported_platform` failure that names the supported
platforms. Release desktop builds bundle darwin-arm64, linux-x64 and linux-arm64
(261 MiB; the nightly app is 634 MB against 452 MB for a host-only bundle). That set
stays for now: the bundle is the only supply when neither side can reach GitHub, and
`goat.runtime.source` now separates `host-download` from `upload`, so trimming it
can wait for evidence of how often uploads still happen.

Integrity is TLS plus `SHA256SUMS` from the same release; the archive executable
must also report the exact version before the install is published. Release
signatures would need a signing key and a verifier on every host, which no host
has today. Channels follow the version string (`cliReleaseChannelOf`), and every
download names one exact tag. The service scheduler follows only the server's
own stable or nightly channel; the SSH client path keeps its exact target. Paid
buckets, CDNs and npm were not needed: GitHub release assets are free, public and
already published by the nightly workflow.

Every build that names a published version can be found there: nightly and stable
come from the same workflow and publish the archives with the apps, and dev and PR
builds never publish, so they upload. A nightly is pruned once it is both outside
the newest 30 and older than 30 days; an app on such a nightly falls back to
uploading its bundled archive. The release repository is the single constant
`CLI_RELEASE_REPOSITORY`, so moving to goat-si/goat changes only that line once it
carries the archives (see [release channels](./release-channels.md#where-releases-go)).

Upstream T3 Code (`pingdotgg/t3code` at `771fd93f`) only downloads on the host,
with a single attempt and no upload. GOAT kept that download block in `run-t3.sh`
and added client supply and upload ahead of it, so outside a mirror the host
never downloaded. The host download is upstream's mechanism restored as the first
step, run from a transient copy of the runner so `run-t3.sh` bytes, and with them
retained-runner identity, do not change.

## Who may update what

R is `orchestration:read`, M is `environment:maintain`, W is `settings:write`.
Default pairing grants all three, because a paired device also holds
`terminal:operate` and can reach the same authority through a shell; narrowing
means pairing with explicit scopes. GOAT adds no administrator role.

| Caller                                                    | Status                  | Idle update                                                | Immediate update                         | Channel or policy           |
| --------------------------------------------------------- | ----------------------- | ---------------------------------------------------------- | ---------------------------------------- | --------------------------- |
| Person at the desktop app                                 | R                       | M                                                          | M and a confirmation                     | W                           |
| Owner at the host's shell (`goat update`, `goat service`) | OS                      | OS                                                         | OS                                       | OS                          |
| Paired desktop, web, or mobile                            | R                       | M                                                          | M and a confirmation                     | W                           |
| Owning SSH client (saved key)                             | R                       | Idle refresh of a runtime it owns; M for the manual update | M and a confirmation                     | Never changed by connecting |
| MCP agent                                                 | R                       | M, `when_idle`                                             | Only after a person approves the handoff | Not through update tools    |
| Linked host, GOAT Connect route                             | The destination's grant | The destination's grant                                    | The destination's grant                  | The destination's grant     |

Rules that hold for every row:

- **Server-side checks.** The server checks the scope when the update executes,
  not only when it is requested; a revoked session cannot finish a pending update.
- **Idle unless confirmed.** A server update that would stop running work waits
  for idle or is refused as busy, unless a person confirmed replacing it now. This
  holds for the launcher path as it already did for SSH drain. Pressing Update in
  a GOAT app is that confirmation (`confirmReplacement`); requests that omit it,
  from older clients or automation, are refused while the server is busy.
- **No self-approval.** A live, writable goatclaw thread in full-access/default modes
  may prepare a pinned SSH host when its enabled profile grants `hub.manage` for
  that host. Its credential, modes and profile are checked at admission and again
  before the job runs; preparation never confirms replacement. Other callers still
  need `environment:maintain`. Idle runtime updates keep their existing authorization. An agent can
  request an immediate update but cannot approve it; the handoff names the host
  and target, and the approver's grant is rechecked when it runs.
- **Never downgrade.** No caller can move a server to an older build through
  these paths. A newer or unowned runtime blocks replacement.
- **Organization policy wins.** A managed setting that disables updates beats
  every row. An app that cannot write its bundle is not evidence of such a policy
  and does not stop server updates.
- **Linking grants nothing new.** Linking a host or routing through GOAT Connect
  changes reachability, not authority. SSH runtime updates are not host-routable.

### Audit

Every update request on a server appends a line to
`<userdata>/maintenance-audit.jsonl` (next to `statev2.sqlite`) and syncs it
before handing off: time, operation ID, launcher update ID once accepted, actor
(session method and ID, or the MCP caller), destination host for SSH updates, from
and target version, mode (idle or confirmed), and outcome (requested, accepted,
failed). Acceptance means the launcher took the update, not that the trial committed.
The file sits outside SQLite so a database rollback cannot erase the record of
the update that caused it. It never contains credentials or signed URLs.

## UX states

States appear in the places that already show updates: the app-rail update
button, Settings, and the Connections row of each environment, on web, desktop,
and mobile. Each names whether it means **this app** or **a server**, and which
environment.

- **Ready.** Nothing shown beyond the version in the row.
- **Update available.** Optional; offers an idle update for a server, or the app
  update.
- **Waiting for idle.** The update is accepted and will run when the server's
  turns finish; it can be confirmed to run now.
- **Updating** (downloading, verifying, draining, restarting, reconnecting).
- **Updated** only after reconnecting to the target version with the matching
  update ID. A reconnect alone is not success.
- **Rolled back.** The previous version is running again; the reason is shown, and
  the same target is not retried automatically.
- **Update unavailable.** The exact build could not be acquired; the server keeps
  running the named compatible version.
- **Cannot update this app.** Typed reason and fix: running from a download or
  disk image (move GOAT to Applications), the bundle is not writable (an
  administrator must install, or make GOAT writable), or updates are disabled.
  The text says that servers, including this Mac's SSH runtime, still update on
  their own.
- **Server too old / app too old / compatibility unknown**, from the verdict table.

## Rollback

The launcher restores the SQLite snapshot and the previous runtime if the trial does
not commit, fails its smoke probe, or exits during the ten-minute probation after
commit; the SSH supervisor restores the database and `run-t3.sh` and starts the
previous version. Both refuse to restore over another server's writes. Once probation
expires the new version is authoritative: a later downgrade is a new, deliberate
update with its own migration check, never a stale client reconnecting.

## Server auto-update

Launcher-managed servers and client-launched SSH runtimes enable
`automaticServerUpdates` by default. The root parks at activation, checks after 10
minutes, then every six hours. Only publishable stable and nightly builds participate,
always on their own channel. Desktop-managed and foreground servers and dev, PR and
preview builds never do. The newest target must be strictly newer and differ from the
last failed or rolled-back target. Both paths share `autoUpdatePolicy.ts`; only
activation and the failed-target record differ.

A release without a valid publication time is ineligible. SHA-256 of
`environmentId:targetVersion`, taking the first four bytes as an unsigned big-endian
integer modulo 100, fixes each server's bucket. Stable waits 48 hours, then opens
over 72 hours; nightly opens over 12 hours without a soak. The bucket's fraction of
the window determines eligibility, so retries and restarts never move a server
into an earlier cohort.

Preparation uses the same checksum verification and preflight as manual updates.
Under the launcher, activation calls `ServerSelfUpdate.update` with actor `auto-update`
and without `confirmReplacement`, retaining both idle checks and admission closure, and
the launcher's last update record is the failed-target memory. Busy
activation retries every 10 minutes using the installed runtime; it does not
redownload. Opt-out is checked again before activation. Discovery or preparation
failure logs and waits for the next six-hour check. The scheduler shares the manual
updater's in-flight guard and never creates a second replacement path.

### Client-launched SSH runtimes

A runtime started by `run-t3.sh` updates itself when its launch records
(`~/.goat/ssh-launch/runtime/pid` and `managed`) name its own process and it runs in
the default `~/.goat` home. Windows hosts take part when Git for Windows bash is
found (the OpenSSH DefaultShell or a standard install path) and otherwise stay
client-driven. Preparation runs the same host download a
client would, verified against `SHA256SUMS`, checks the executable against its install
record, and runs `__service-preflight`. Activation checks idle, then runs the owning
launch script in its own session with the target release as the requested version.
The script checks the candidate against the protocol the target binary reports. The
runtime only moves to a target whose protocol it already serves, so the script takes
its idle-only refresh path and the target's supervisor accepts this version again on
rollback. A release that changes the protocol is left to clients: a client on that
release finds the runtime incompatible and replaces it as before. The script holds the host replacement lock, checks idle again, drains (which
closes admission) and starts the ADR-0013 supervisor. The drain stops this server, so
nothing in it can interrupt the swap. A busy check, a cancelled drain, or a client
holding the lock retries in 10 minutes.

On Windows, PowerShell 5.1 compiles the command supervisor before Node detaches its
executable: detaching PowerShell itself can exit successfully without running its
script. The executable owns a kill-on-close Job Object before starting Git Bash.
It stays alive while descendants hold command output, even if Bash exits
first. Timeout and cancellation terminate that supervisor through its retained native
process handle, so cleanup neither depends on a live parent PID nor selects a reused
PID. The replacement supervisor and server use the existing WMI detached launch,
outside the command job, and survive the updater's exit.

Cleanup initially belongs to the supervisor's job without holding its handle, so timeout
or interruption also stops cleanup before readiness. After cleanup acknowledges its retained
supervisor handle, it receives a non-inheritable job handle. It can then remove the exact helper
directory after supervisor exit, even when the original server drained first; its own exit
closes the final job handle and stops any remaining descendants. Unlaunched preparation
remains the original caller's responsibility.

The supervisor writes `last-replacement.json` (status, target, previous version) in the
launch state directory for every swap it runs. A `rolled-back` or `failed` record is the
failed-target memory, so it covers swaps started by clients as well, and it survives the
rollback because the restored server reads the file the supervisor wrote.

Clients sharing a runtime hold no lock or lease. A new client marks its automatic idle
refresh of an older runtime with `automatic: true` on the drain request. The runtime
arbitrates it with `arbitrateAutomaticTargets` against its own prepared target and
answers `cancelled` without draining unless the request is the newest same-channel,
strictly newer, never-failed candidate, and while `automaticServerUpdates` is off it
drops every marked request. Manual and confirmed updates, incompatible
replacements, and requests from older clients carry no marker and behave as before,
so a runtime on a dev build, or an older client moving a runtime to its release, is
unchanged. Compatibility after an update is still `hostCompatibilityOf`: a runtime newer
than a client keeps serving it while the client's protocol is in range, and names the
client as the side to update once it is not. Runtimes without `drainRestart` stay
attach-only because the launch script refuses to drain them.

## Migration plan

1. Read the advertised orchestration range everywhere (no behavior change while
   the range is a single version).
2. Idle-or-confirmed admission for launcher updates, and the audit journal.
3. Install records for SSH runtimes, and recovery to a recorded newer install
   when the exact archive is missing.
4. Typed reasons when the desktop app cannot update itself.
5. Follow-ups: run the desktop's local server under a launcher in user storage
   so it can update without the app, preserving its identity, data, and port
   (this also narrows issue #1, where the desktop and SSH servers on one host are
   separate environments); serve the previous protocol only when a protocol bump
   needs it. The idle-only scheduler is implemented as described above, for service
   installs and client-launched SSH runtimes.

## Test plan

- Protocol: both ends of the served range and one beyond, over `/ws`, the HTTP
  header, the client check and the outdated-host check; malformed ranges fail
  closed.
- Admission: a busy, unconfirmed launcher update is refused without contacting
  the launcher; a confirmed one proceeds; the journal line exists before handoff.
- Supply: a planted directory with a forged `.install-complete` and no matching
  record is never executed or selected; a recorded newer compatible install beats
  an older retained one when the exact archive is missing; an unordered candidate
  is not chosen; the exact-archive path is unchanged.
- Desktop: translocated, disk image, unwritable bundle, and writable bundle each
  produce the right reason.
- Integrated: with the app unable to update, a remote SSH runtime and a
  `goat service` install still update, and the app keeps working within the
  range. Tests wait on persisted milestones or `Deferred`, never sleeps.
