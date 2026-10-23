import { entry } from "../entry.ts";

export const hostEntries = {
  "host.status": entry({
    resource: "host",
    verb: "status",
    name: "goat_host_status",
    toolkit: "hostStatus",
    summary:
      "Read version, load, memory, disk, thread counts, providers and quota for this machine and every connected or linked host.",
    description:
      "Read host status for this machine and every SSH host this process is connected to and every linked host: GOAT version, CPU, memory, load average, disk free space, running/waiting/queued thread counts, every configured provider instance (providers), cached provider quota for those that report it (quotas), and the resource pressure each machine reports for itself (pressure: ok, elevated or critical, with reasons). Pass placement ({} or the providerInstanceId, driver or platform a new lane needs) to rank the reported hosts for that lane: placement.candidates lists eligible hosts best first, then skipped ones with why. Pass host (an SSH alias from goat_ssh_host_list or a linked host from goat_host_link_list) for one other machine. Pass local:true for this machine only. Reaching another machine needs a caller allowed to use this machine's SSH keys. An unreachable host keeps its last successful sample. A remote GOAT that does not offer this tool is reported as unsupported. compatibility says whether a reachable host works with this machine, from the protocols it serves: compatible (different GOAT versions are fine), incompatible (its message names which machine to update), or degraded (the host is too old to report its protocols; update it). versionMismatch:true only marks a different GOAT build.",
    effect: "read",
    hostRoutable: true,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "host.cordon": entry({
    resource: "host",
    verb: "cordon",
    name: "goat_host_cordon",
    toolkit: "fleetHealth",
    summary: "Stop placing new goal work on a host",
    description:
      'Cordon a host ("local" for this machine): goal controllers and goat_thread_reschedule stop placing new or moved work there. Threads already running on it are not touched. The cordon is saved and survives a restart; goat_host_uncordon lifts it, and goat_host_status shows a Cordoned condition. Needs a full-access caller.',
    effect: "write",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
  "host.uncordon": entry({
    resource: "host",
    verb: "uncordon",
    name: "goat_host_uncordon",
    toolkit: "fleetHealth",
    summary: "Allow placements on a cordoned host again",
    description:
      "Lift a cordon or drain from a host so goal controllers may place work there again. Work already moved off it stays where it is. Needs a full-access caller.",
    effect: "write",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
  "host.drain": entry({
    resource: "host",
    verb: "drain",
    name: "goat_host_drain",
    toolkit: "fleetHealth",
    summary: "Cordon a host and move its goal attempts away between runs",
    description:
      "Drain a host: cordon it and mark it Draining, so the goal controller moves each goal attempt on it to another host once its current run ends, one slot per goal at a time. A running turn is never interrupted, and threads that no goal owns are never moved. goat_host_uncordon ends the drain. Needs a full-access caller.",
    effect: "write",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
