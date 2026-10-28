import { entry } from "../entry.ts";

export const hostEntries = {
  "host.resource_history": entry({
    resource: "host",
    verb: "resource_history",
    name: "goat_host_resource_history",
    toolkit: "hostStatus",
    summary: "Read bounded host resource telemetry history.",
    description:
      "Read bounded host resource telemetry history. Requires an explicit diagnostics:read client grant and live reauthorization.",
    guide:
      "Returns host telemetry buckets, top processes and collection health. The window is capped at 1 hour, with 240 points, 64 processes and 1 KiB command/name strings within 256 KiB. truncated marks cuts or a clamped request. Only outside MCP clients with an explicit diagnostics:read grant and live reauthorization may call this. GOAT thread credentials are refused, including full-access threads. Reads stay on this host.",
    parameters: {
      windowMs: "Requested history window in milliseconds, clamped to 1 second through 1 hour.",
      bucketMs: "Requested bucket width in milliseconds; raised to limit the result to 240 points.",
    },
    examples: [
      {
        title: "Read bounded host resource telemetry history.",
        args: { windowMs: 3600000, bucketMs: 60000 },
      },
    ],
    effect: "read",
    hostRoutable: false,
    requires: "client",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  }),
  "host.process_history": entry({
    resource: "host",
    verb: "process_history",
    name: "goat_host_process_history",
    toolkit: "hostStatus",
    summary: "Read bounded GOAT process resource history.",
    description:
      "Read bounded GOAT process resource history. Requires an explicit diagnostics:read client grant and live reauthorization.",
    guide:
      "Returns CPU and memory history for GOAT backend processes. The window is capped at 1 hour, with 240 points, 64 processes and 1 KiB command strings within 256 KiB. truncated marks cuts or a clamped request. Only outside MCP clients with an explicit diagnostics:read grant and live reauthorization may call this. GOAT thread credentials are refused, including full-access threads. Reads stay on this host.",
    parameters: {
      windowMs: "Requested history window in milliseconds, clamped to 1 second through 1 hour.",
      bucketMs: "Requested bucket width in milliseconds; raised to limit the result to 240 points.",
    },
    examples: [
      {
        title: "Read bounded GOAT process resource history.",
        args: { windowMs: 3600000, bucketMs: 60000 },
      },
    ],
    effect: "read",
    hostRoutable: false,
    requires: "client",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: false },
  }),
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
      "The call can target one SSH alias from goat_ssh_host_list or one linked name from goat_host_link_list, or return this machine alone. Remote reads require a live caller allowed to reach hosts with this machine's SSH keys; read-only MCP clients cannot make them. Metrics include GOAT version, CPU, memory, load averages, disk free space and running, waiting and queued thread counts; those three counts exclude archived, deleted and subagent threads. Providers include every configured instance; quotas include instances that report usage limits. Quota reads can refresh stale provider limits, at most once per minute. Hosts that report pressure supply an ok, elevated or critical level and reasons. Placement ranks eligible reported hosts first, best score first, then ineligible hosts with reasons. An empty placement request ranks without extra requirements; provider instance, driver and platform can constrain it. Unreachable entries retain metrics from the last successful sample when available, marked lastKnown. A remote without goat_host_status is unsupported. Compatibility compares served protocols: compatible permits different builds; incompatible names which machine needs updating; degraded means the host does not report its protocols. versionMismatch is also true when the remote omits its version. A metrics section that is not JSON is omitted and named in omittedMetrics; the rest of that host and the other hosts are still returned. opencodexChild.setup reports a Child's setup step, failure, next action and persisted Ready proof. A linked Child is Ready only after one real model request from its managed Codex instance succeeds through Home; that request uses Home's shared quota. Reading this status never starts a model request, and a configuration or link change invalidates the proof. goat_hub_device_setup retries or finishes setup.",
    examples: [
      { title: "Pick the best host for a new lane", args: { placement: {} } },
      { title: "Check one SSH host", args: { host: "devbox" } },
    ],
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
      "Clear a host's cordon and drain flags so goal placements can use it again. Previously moved work stays where it is, and drain moves not yet started are called off.",
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
      "Persistently cordon a host and mark it Draining, excluding it from new placements. Fleet goal attempts on it move to another host between runs, one per goal at a time; running turns and threads no goal owns stay. Use goat_host_uncordon to clear both flags and stop further moves.",
    guide:
      "Needs a live full-access/default calling thread or a full-access client, plus hub.manage for a GOAT thread when goatclaw is enabled. Moves run on later goal passes under each goal owner's authority; an attempt with no other allowed host, or on its last attempt, stays and its goal reports why. goat_thread_reschedule moves another thread by hand; a goal keeps following the original thread, not the moved one.",
    effect: "write",
    capability: "hub.manage",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "The handler only calls FleetHostStates.cordon with draining:true, upserting one host row. Repeating sets the same flags; goal passes move idle attempts on their own schedule, so a repeat starts no extra moves.",
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
