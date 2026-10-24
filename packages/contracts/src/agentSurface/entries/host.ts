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
      "Read capacity, thread activity, configured providers, quota and compatibility for this machine and connected or linked hosts, with optional placement ranking. Unreachable hosts may show stale metrics; different build versions alone do not mean incompatibility.",
    guide:
      "The call can target one SSH alias from goat_ssh_host_list or one linked name from goat_host_link_list, or return this machine alone. Remote reads require a live caller allowed to reach hosts with this machine's SSH keys; read-only MCP clients cannot make them. Metrics include GOAT version, CPU, memory, load averages, disk free space and running, waiting and queued thread counts; those three counts exclude archived, deleted and subagent threads. Providers include every configured instance; quotas include instances that report usage limits. Quota reads can refresh stale provider limits, at most once per minute. Hosts that report pressure supply an ok, elevated or critical level and reasons. Placement ranks eligible reported hosts first, best score first, then ineligible hosts with reasons. An empty placement request ranks without extra requirements; provider instance, driver and platform can constrain it. Unreachable entries retain metrics from the last successful sample when available, marked lastKnown. A remote without goat_host_status is unsupported. Compatibility compares served protocols: compatible permits different builds; incompatible names which machine needs updating; degraded means the host does not report its protocols. versionMismatch is also true when the remote omits its version.",
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
      "Persistently exclude a host from new goal placements and goat_thread_reschedule targets. Existing threads keep running. Use goat_host_uncordon to allow placements again.",
    guide:
      "The local host is stored as local. The cordon survives server restarts because it is saved in the fleet database. goat_host_status reports a Cordoned condition. Cordoning an already draining host preserves its drain flag. Needs a live full-access/default calling thread or a full-access client, plus hub.manage for a GOAT thread when goatclaw is enabled.",
    effect: "write",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "FleetHostStates.cordon upserts one row by host, setting cordoned and reason while preserving an existing drain; repeating does not launch work.",
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
      "Clear a host's cordon and drain flags so goal placements can use it again. Previously moved work stays where it is.",
    guide:
      "Needs a live full-access/default calling thread or a full-access client, plus hub.manage for a GOAT thread when goatclaw is enabled.",
    effect: "write",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "FleetHostStates.uncordon deletes the single state row by host; a repeat removes no additional state and starts no work.",
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
    summary: "Cordon a host and mark it Draining",
    description:
      "Persistently cordon a host and mark it Draining, excluding it from new placements. Existing goal attempts are currently not moved automatically. Use goat_host_uncordon to clear both flags.",
    guide:
      "Needs a live full-access/default calling thread or a full-access client, plus hub.manage for a GOAT thread when goatclaw is enabled. To move a goal attempt off the host, call goat_thread_reschedule for it.",
    effect: "write",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "The handler only calls FleetHostStates.cordon with draining:true, upserting one host row. Repeating sets the same flags and does not launch evacuation work.",
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
