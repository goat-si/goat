import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderUsageLimits } from "./providerUsageLimits.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";

/**
 * Wire shape for `goat_host_status`. A later GUI reads this schema; add fields
 * as optional so a client built against this payload still decodes.
 */

/** 1, 5, and 15 minute load averages. Null on Windows, which does not report them. */
export const HostLoadAverage = Schema.Struct({
  oneMinute: Schema.Number,
  fiveMinutes: Schema.Number,
  fifteenMinutes: Schema.Number,
});
export type HostLoadAverage = typeof HostLoadAverage.Type;

/** Free space on the volume `path` sits on, from `fs.statfs`. */
export const HostDiskUsage = Schema.Struct({
  path: TrimmedNonEmptyString,
  availableBytes: NonNegativeInt,
  totalBytes: NonNegativeInt,
});
export type HostDiskUsage = typeof HostDiskUsage.Type;

/**
 * Whole-host capacity plus load and disk. `server.getHostResources` still
 * publishes only `HostResourcesSnapshot`; these extras ride the host-status tool.
 */
export const HostCapacitySnapshot = Schema.Struct({
  ...HostResourcesSnapshot.fields,
  loadAvg: Schema.NullOr(HostLoadAverage),
  disk: Schema.NullOr(HostDiskUsage),
});
export type HostCapacitySnapshot = typeof HostCapacitySnapshot.Type;

/** Active threads on that machine. Preparing and starting count as running. */
export const HostThreadCounts = Schema.Struct({
  running: NonNegativeInt.annotate({
    description: "Threads preparing, starting, or running a turn. Subagents are not included.",
  }),
  waiting: NonNegativeInt.annotate({
    description: "Threads waiting on a person or another runtime request.",
  }),
  queued: NonNegativeInt.annotate({
    description: "Threads with a queued turn that has not started.",
  }),
});
export type HostThreadCounts = typeof HostThreadCounts.Type;

/**
 * One provider account's subscription quota. `fromCache` is true when this
 * call did not refresh that account. `limits.checkedAt` is when the provider
 * last reported the windows.
 */
export const HostStatusQuota = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  limits: ServerProviderUsageLimits,
  fromCache: Schema.Boolean,
});
export type HostStatusQuota = typeof HostStatusQuota.Type;

export const HostStatusMetrics = Schema.Struct({
  ...HostCapacitySnapshot.fields,
  /** `process.platform` of that machine (`linux`, `darwin`, `win32`). Older hosts omit it. */
  platform: Schema.optional(TrimmedNonEmptyString),
  threads: HostThreadCounts,
  quotas: Schema.Array(HostStatusQuota),
});
export type HostStatusMetrics = typeof HostStatusMetrics.Type;

export const HostStatusReachability = Schema.Literals(["ok", "unreachable", "unsupported"]);
export type HostStatusReachability = typeof HostStatusReachability.Type;

/**
 * One machine. `host` null is the machine that answered. `unsupported` means
 * that machine's GOAT is too old to report this payload. `unreachable` with
 * `lastKnown: true` repeats the last successful metrics.
 */
export const HostStatusEntry = Schema.Struct({
  host: Schema.NullOr(TrimmedNonEmptyString),
  reachability: HostStatusReachability,
  lastKnown: Schema.optional(Schema.Literal(true)),
  metrics: Schema.optional(HostStatusMetrics),
  message: Schema.optional(Schema.String),
});
export type HostStatusEntry = typeof HostStatusEntry.Type;

export const GoatHostStatusResult = Schema.Struct({
  hosts: Schema.Array(HostStatusEntry),
});
export type GoatHostStatusResult = typeof GoatHostStatusResult.Type;

/** Same alias rules as the other host tools, with this tool's own description. */
const HostAlias = TrimmedNonEmptyString.check(Schema.isMaxLength(255)).annotate({
  description:
    "SSH host alias from goat_ssh_host_list. Reports that machine only, and does not fan out from there.",
});

export const GoatHostStatusInput = Schema.Struct({
  host: Schema.optional(HostAlias),
  local: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true, report only this machine. A fan-out calls each SSH host with local:true so that machine does not fan out again. Cannot be combined with host.",
  }),
});
export type GoatHostStatusInput = typeof GoatHostStatusInput.Type;
