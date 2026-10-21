import * as Schema from "effect/Schema";

import { ForwardCompatibleOptional, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeProtocolRanges } from "./environment.ts";
import { HostCondition } from "./fleetHealth.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderUsageLimits } from "./providerUsageLimits.ts";
import { QuotaPool } from "./quotaPool.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";
import { OpenCodexInventorySnapshot } from "./opencodex.ts";

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

/** A provider instance configured on that machine, whether or not it reports usage limits. */
export const HostStatusProvider = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
});
export type HostStatusProvider = typeof HostStatusProvider.Type;

export const HostStatusMetrics = Schema.Struct({
  ...HostCapacitySnapshot.fields,
  /** `process.platform` of that machine (`linux`, `darwin`, `win32`). Older hosts omit it. */
  platform: Schema.optional(TrimmedNonEmptyString),
  threads: HostThreadCounts,
  /** Only the instances that report usage limits; `providers` lists every configured one. */
  quotas: Schema.Array(HostStatusQuota),
  /** Every configured provider instance. Older hosts omit it, so only `quotas` says what they have. */
  providers: Schema.optional(Schema.Array(HostStatusProvider)),
  quotaPool: Schema.optional(QuotaPool),
  /** Read-only inventory of this host's OpenCodex. Older hosts omit it. */
  opencodex: ForwardCompatibleOptional(OpenCodexInventorySnapshot),
});
export type HostStatusMetrics = typeof HostStatusMetrics.Type;

export const HostStatusReachability = Schema.Literals(["ok", "unreachable", "unsupported"]);
export type HostStatusReachability = typeof HostStatusReachability.Type;

/**
 * A reachable host relative to the machine that fanned out, from the protocol ranges it serves.
 * `degraded` means it answered but cannot show compatibility (it predates reporting ranges).
 */
export const HostCompatibility = Schema.Literals(["compatible", "degraded", "incompatible"]);
export type HostCompatibility = typeof HostCompatibility.Type;

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
  /** GOAT version that machine runs. Older hosts omit it. */
  serverVersion: Schema.optional(TrimmedNonEmptyString),
  /** Protocol ranges that machine serves. Older hosts omit it. Partial or malformed ranges decode
      away, so a host that sends them stays reachable and is judged `degraded`. */
  protocol: ForwardCompatibleOptional(RuntimeProtocolRanges),
  /**
   * The host runs a different GOAT build than the machine that fanned out, or does not say
   * which. Informational: builds of different versions work together while `compatibility`
   * is `compatible`. Kept for clients and agents that predate `compatibility`.
   */
  versionMismatch: Schema.optional(Schema.Literal(true)),
  /** Set by the machine that fanned out, for reachable remote hosts. A verdict a client does not
      know decodes away, so a later verdict cannot break an older client. */
  compatibility: ForwardCompatibleOptional(HostCompatibility),
  message: Schema.optional(Schema.String),
  /** Self-healing conditions this machine derived for the host. Older servers omit it. */
  conditions: Schema.optional(Schema.Array(HostCondition)),
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

/** `server.getHostStatus` input. An older server ignores `local` and answers with its usual fan-out. */
export const ServerGetHostStatusInput = Schema.Struct({
  local: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true, report only the machine that answers, without contacting its SSH hosts.",
  }),
});
export type ServerGetHostStatusInput = typeof ServerGetHostStatusInput.Type;
