import * as Schema from "effect/Schema";

import {
  ForwardCompatibleOptional,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RuntimeProtocolRanges } from "./environment.ts";
import { HostCondition } from "./fleetHealth.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderUsageLimits } from "./providerUsageLimits.ts";
import { QuotaPool } from "./quotaPool.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";
import { OpenCodexInventorySnapshot } from "./opencodex.ts";
import { HubParityResult } from "./hubParity.ts";

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
 * Per-host storage budgets. Memory is the memory store's tables; history is everything else in
 * the state database, almost all orchestration events and projections. They grow for different
 * reasons and are fixed differently, so each has its own budget.
 */
export const HOST_STORAGE_BUDGETS = {
  memoryBytes: 100 * 1024 ** 2,
  historyBytes: 2 * 1024 ** 3,
} as const;

/** The last on-demand or scheduled history compaction this server finished. */
export const HostStorageCompactionResult = Schema.Struct({
  finishedAt: IsoDateTime,
  removedEvents: NonNegativeInt,
  /** How much smaller the database file got. */
  freedBytes: NonNegativeInt,
  /**
   * The database predates incremental auto_vacuum, so removed history stays allocated in the file
   * until an offline `goat doctor` runs on that machine.
   */
  needsOfflineCompaction: Schema.Boolean,
});
export type HostStorageCompactionResult = typeof HostStorageCompactionResult.Type;

/** The state database of the machine that answered, from its once-a-minute storage pass. */
export const HostStorageHealth = Schema.Struct({
  databaseBytes: NonNegativeInt,
  /** Null when the memory tables could not be measured on this SQLite build. */
  memoryBytes: Schema.NullOr(NonNegativeInt),
  /** Database bytes that are neither memory nor free pages. */
  historyBytes: NonNegativeInt,
  /** Free pages inside the file. */
  reclaimableBytes: NonNegativeInt,
  measuredAt: IsoDateTime,
  /** Set while a history compaction runs. */
  compactingSince: Schema.optional(IsoDateTime),
  lastCompaction: Schema.optional(HostStorageCompactionResult),
});
export type HostStorageHealth = typeof HostStorageHealth.Type;

/**
 * A GOAT server this machine's user started that nothing can use any more: its launcher exited
 * (it was reparented to PID 1), and its GOAT home was deleted or is a temporary home, as test
 * runs leave behind. A server with a real home is never one, whatever version it runs.
 */
export const HostStrayProcess = Schema.Struct({
  pid: PositiveInt,
  startedAt: IsoDateTime,
  kind: Schema.Literal("orphaned_server"),
  reason: Schema.Literals(["home_deleted", "temporary_home"]),
  baseDir: Schema.String,
});
export type HostStrayProcess = typeof HostStrayProcess.Type;

export const HostStrayProcesses = Schema.Struct({
  scannedAt: IsoDateTime,
  processes: Schema.Array(HostStrayProcess),
});
export type HostStrayProcesses = typeof HostStrayProcesses.Type;

/** `server.cleanUpStrayProcesses`: what was stopped, and what is left after a fresh scan. */
export const HostStrayCleanupResult = Schema.Struct({
  stopped: NonNegativeInt,
  /** Of those stopped, how many ignored SIGTERM and needed SIGKILL. */
  forced: NonNegativeInt,
  failed: Schema.Array(Schema.Struct({ pid: PositiveInt, message: Schema.String })),
  remaining: HostStrayProcesses,
});
export type HostStrayCleanupResult = typeof HostStrayCleanupResult.Type;

export class HostMaintenanceError extends Schema.TaggedError<HostMaintenanceError>()(
  "HostMaintenanceError",
  {
    operation: Schema.Literals(["compact_storage", "clean_up_strays"]),
    message: Schema.String,
  },
) {}

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
  /** Older hosts omit it; a host that sends it also serves `server.compactStorage`. */
  storage: ForwardCompatibleOptional(HostStorageHealth),
  /** Older hosts omit it; a host that sends it also serves `server.cleanUpStrayProcesses`. */
  strays: ForwardCompatibleOptional(HostStrayProcesses),
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
  parity: ForwardCompatibleOptional(HubParityResult),
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
  parityEvidence: Schema.optional(Schema.Boolean).annotate({
    description:
      "With local:true, collect fresh read-only hub parity evidence, including one GET /v1/models.",
  }),
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
