# ADR-0020 — decision recorded under "Resource pressure"

- Contract owner: [launch-and-remote-dispatch.md](../launch-and-remote-dispatch.md#resource-pressure)
- Related: [ADR-0009](ADR-0009-launch-watches.md), [ADR-0017](ADR-0017-agentic-self-healing.md),
  [ADR-0018](ADR-0018-agentic-resources-fallback.md), [agentic-k8s.md](../../docs/internals/agentic-k8s.md#resources-and-placement)

## Decision record

- **Purpose.** On 2026-10-21 about eight orchestrator and child threads ran installs, browser test
  suites, knip and typechecks on one 18-core laptop at once. Load reached 111, the GOAT server's
  event loop stalled for up to 26 s, and every remote follow failed as unreachable while idle hosts
  sat unused. Nobody was told. Orchestrating agents need to hear when a machine they run work on
  is overloaded, and need a ranking that sends the next lane somewhere with room.
- **Before.** `goat_host_status` reported CPU, load, memory, disk and thread counts, and
  `EventLoopMonitor` logged stalls to `event-loop-stalls.ndjson`, but nothing classified them,
  nothing reached an agent, and goal placement ignored load beyond thread counts.
- **Alternatives considered.**
  - The orchestrating machine classifies every host from raw metrics. It cannot see a remote
    server's event-loop stalls, and each origin would hold different hysteresis for the same host.
  - A separate pressure probe or a new MCP tool for placement. A new probe adds SSH traffic; a new
    tool duplicates the host read agents already make. The k8s design keeps placement next to
    host status.
  - Hard admission by default. A person's own launch is never refused by fleet limits
    (ADR-0018), and pressure readings can be wrong for a minute.
  - A composer banner in every thread on a pressured machine. It needs a host-status read per open
    thread, which samples CPU, so the notice goes into the orchestrating threads instead.
- **Chosen.**
  - Each server classifies itself (`HostPressureMonitor`, every 30 s): load per core, whole-host CPU,
    free memory, free disk, and its own event-loop stalls. A level rises after its reading holds
    for `sustainMs` (default 2 min); a stall of `criticalEventLoopDelayMs` (5 s) is critical at once.
    A level falls only after readings stay under 80 % of the thresholds for `sustainMs`. The
    result rides that machine's own `goat_host_status` entry as `pressure`, so remote pressure arrives
    with the existing fan-out; a host that predates it is classified from its metrics.
  - `PressureNudger` (every 60 s) reads this machine's level and, only for hosts with launch watches
    that still have runs to report, the fan-out. Recipients are the threads that started work
    there (`launchedBy` or subagent parent for local work, the watch's launcher for remote work)
    and their own launchers up to the thread a person started. Rising to critical wakes them
    through the same queued `message.dispatch` launch reports use; elevated, easing and recovery
    are thread notices that start no turn. Each host and level is announced at most once per
    `notifyCooldownMs` (15 min). The message names the readings, the running work, hosts with room
    and a suggested move.
  - `goat_host_status` takes `placement` requirements and returns a ranking: filter (reachable,
    compatible, not cordoned, platform, provider, quota, not critical), then score with
    channelPlacement's weights plus load per core and an elevated penalty. Goal placement refuses
    a critical host with `host_pressure`.
  - `goat_thread_launch`, `goat_ssh_thread_launch` and `delegate_task` return `pressure` advice beside
    their result when the target is elevated or critical, from readings already held, never a new
    probe. `fleet.pressure.admission: "block"` refuses launches onto a critical host.
  - Settings live in `fleet.pressure` and are on by default. Fleet shows an alert per pressured host.
- **Consequences.** Pressure is advisory for people and binding only for goal placement and an
  explicit block. Announcement state is in memory, so a restart can repeat one notice. Work on a
  host is attributed to threads and worktrees, not processes, because process telemetry has no
  thread owner. A machine that launched work elsewhere is only told about that host while its
  watch still has runs to follow.
