# ADR-0019 — decision recorded under "Updates"

- Contract owner: [server.md](../server.md#updates)
- Related: [ADR-0012](ADR-0012-shared-ssh-runtime.md), [ADR-0013](ADR-0013-drain-replacement.md),
  [remote updates](../../docs/internals/remote-updates.md)

## Decision record

- **Purpose.** Users rarely update by hand, so a GOAT server has to move to a verified newer build
  on its own, only when that build is safe for it, and keep working with clients and hosts on other
  builds in the meantime.
- **Before.**
  - Protocol ranges already decided whether a client could attach (`compareRuntimeProtocols`,
    `ORCHESTRATION_PROTOCOL_MIN_SERVED`), but `goat_host_status` compared release strings.
    `markVersionMismatch` warned whenever two hosts ran different builds, so a Windows host on a
    nightly next to a fleet on a dev build showed a mismatch forever while working fine.
  - Servers moved only when a person, an agent, or the owning SSH client asked. A `goat service`
    install nobody visited stayed on its first version.
  - The launcher committed a trial as soon as the trial said `prepared`. A build that bound HTTP
    and then crashed after activation, or answered with the wrong version, stayed committed, and
    the service manager restarted it in a loop.
  - Dev builds publish no archives and the desktop bundle carries no win32 archive, so a Windows SSH
    host could never get a dev client's exact runtime.
- **Alternatives.**
  - Keep comparing versions and add an allow list of "known compatible" pairs. It is a second
    compatibility scheme next to the protocol ranges and goes stale with every build.
  - A version-based minimum client (`minClientVersion`). Dev, nightly and stable strings of one
    core do not order without commit times, and a floor can contradict the served protocol range.
    #456 rejected it for the same reason.
  - Let every server follow "latest" on any channel. It would move nightly users to stable
    regressions and could move anyone onto preview, which must never reach end users.
  - CI uploads dev archives for all five targets on every `dev` push. It costs five builds per merge
    (two on Windows runners, one notarized on the Mac Studio runner) to serve a handful of
    maintainer hosts, and dev archives would need their own retention and pruning.
- **Decision.**
  - **Verdict, not version.** A reachable remote host gets one of three verdicts relative to the
    machine that fanned out, computed by `hostCompatibilityOf` in
    `packages/shared/src/sshRuntimeProtocol.ts` on top of `compareRuntimeProtocols`:
    - `compatible`: the host advertises valid protocol ranges and they include every protocol this
      machine speaks (SSH runner and orchestration). Release strings may differ; that is
      informational.
    - `incompatible`: it advertises valid ranges that miss this machine's protocol. The message
      names the one side to update (the host when it is older, this machine when it is newer).
    - `degraded`: it answered but compatibility cannot be shown, because it predates reporting its
      ranges or advertised malformed ones. Status and basic tools work; the message asks to update
      that host so it can report.
  - `HostStatusEntry` gains optional `protocol` (the ranges the host serves) and `compatibility`.
    `versionMismatch` stays and keeps its meaning (the strings differ) so older decoders and agents
    keep working. Clients and the MCP message derive warnings from `compatibility` only.
  - **Server auto-update.** A server under the service launcher (`goat service`, which is how
    headless and SSH hosts run independently of an app) checks its own channel and updates itself
    through the existing launcher trial. It is on by default and turned off with the server setting
    `automaticServerUpdates`. Rules:
    - Only stable and nightly builds follow their own channel. Preview, dev and PR builds never
      update automatically, and no automatic path selects a target on another channel, so nothing
      moves a user onto preview.
    - The target is the newest release of that channel that is strictly newer, is not the target of
      the last failed or rolled-back update the launcher recorded, and whose rollout has reached
      this server.
    - Staged rollout: each server has a stable bucket from 0 to 99 (SHA-256 of environment ID and
      target version). A stable release waits 48 hours after publication, then opens to buckets
      over the next 72 hours. A nightly opens over 12 hours with no soak. A release without a
      publication time is never eligible.
    - Download, `SHA256SUMS` verification and preflight run in the background as soon as a target
      is eligible. Activation goes through `ServerSelfUpdate.update` without
      `confirmReplacement`, so it closes admission and requires idle twice, exactly like an
      unconfirmed person. A busy server defers and retries every 10 minutes. Automatic updates
      never interrupt work.
  - **Post-update health check.** The launcher commits a trial only after it reported `prepared`
    with its port and a smoke probe of `/.well-known/goat/environment` on loopback returned the
    target version with valid protocol ranges within 30 seconds. After commit the update stays on
    probation for 10 minutes with the database snapshot kept. If the new child exits during
    probation, the launcher rolls back exactly as for a failed trial (restore the snapshot only when
    no other server wrote since it, start the previous version) and records `rolled-back` with the
    reason. The rolled-back target is never retried automatically.
  - **Runtime source for dev and Windows hosts.** No CI dev archives. A dev client does not need its
    exact build on a host, only a compatible one, so the order is: attach to a compatible running
    runtime; on a cold host use the newest compatible published runtime (#456); otherwise upload
    an archive from the bundle or the local cache. A maintainer who needs the exact dev build on a
    win32 host either cuts a nightly from that commit (`goat-nightly` `workflow_dispatch`, which
    builds and publishes all five targets) or builds the archive on that host with
    `node scripts/dev-runtime-archive.ts` and copies it into the client's archive cache.
- **Reasons.**
  - One comparator decides attachment, replacement and display, so the three cannot disagree.
  - The launcher trial already owns migrations, snapshots, owner-lock checks and rollback. Auto
    update only decides when to ask; it adds no second replacement path.
  - Staging by a stable bucket lets a bad stable release reach a slice of the fleet first, without
    a server-side rollout service. The soak covers the hours in which a regression is usually
    reported.
  - Probation catches the failure the trial cannot see: a build that starts, commits, then dies.
- **Tradeoffs.**
  - Hosts that predate this change show `degraded` until they update, instead of a false mismatch.
  - A client-launched SSH runtime (`run-t3.sh`) owns its own schedule (#491). It runs the same
    policy (`apps/server/src/cloud/autoUpdatePolicy.ts`) and activates through the ADR-0013
    drain-replacement supervisor instead of the launcher trial, by running the same owning launch
    script a client would, detached on the host. Its failed-target memory is the supervisor's
    `last-replacement.json` in the launch state directory. Clients sharing the runtime get no lock
    or lease: a new client marks its automatic idle refresh, and the runtime drops such a request
    unless it is the newest same-channel target strictly newer than itself and not the last failed
    one. Older clients send no marker and keep their behavior, including moving a runtime to their
    own release. Windows hosts, servers outside the default home, and releases that speak a
    protocol the runtime does not serve stay client-driven, so a rollback always restarts a
    version the new supervisor accepts.
  - A rollback during probation discards what the new version wrote in those minutes, as ADR-0013
    already accepts for the SSH supervisor.
  - A trial from before this change reports no port. The launcher then skips the smoke probe but
    still applies probation. Automatic updates only move forward, so this applies only to manual
    updates to such builds.
  - Rollout constants are fixed in code. A per-organization percentage needs a managed policy,
    which GOAT does not have yet.
