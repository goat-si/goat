import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Resource pressure on one machine (ADR-0020). Each GOAT server classifies itself and reports
 * the result in its goat_host_status entry, so pressure on a remote host travels with the
 * existing fan-out. Every field is optional on the wire; a host that predates it omits it.
 */

export const HostPressureLevel = Schema.Literals(["ok", "elevated", "critical"]);
export type HostPressureLevel = typeof HostPressureLevel.Type;

export const HostPressureSignal = Schema.Literals(["load", "cpu", "memory", "disk", "event_loop"]);
export type HostPressureSignal = typeof HostPressureSignal.Type;

/** One reading that pushed the level up, with the threshold it crossed. */
export const HostPressureReason = Schema.Struct({
  signal: HostPressureSignal,
  level: Schema.Literals(["elevated", "critical"]),
  message: Schema.String,
});
export type HostPressureReason = typeof HostPressureReason.Type;

export const HostPressure = Schema.Struct({
  level: HostPressureLevel,
  /** When the host entered this level (ISO 8601). */
  since: IsoDateTime,
  reasons: Schema.Array(HostPressureReason),
  /** One-minute load average divided by logical cores; null where the OS has none (Windows). */
  loadPerCore: Schema.NullOr(Schema.Number),
  /** The longest event-loop stall of this GOAT server in the last ten minutes, in ms, at any level. */
  eventLoopDelayMs: Schema.NullOr(NonNegativeInt),
});
export type HostPressure = typeof HostPressure.Type;

/**
 * This machine's free disk space and the level it shows on its own, held with the same
 * thresholds and hysteresis as `HostPressure` but ignoring every other signal, so a client can
 * warn about the disk without a busy CPU raising or clearing it.
 */
export const HostDiskPressure = Schema.Struct({
  level: HostPressureLevel,
  /** When the disk entered this level (ISO 8601). */
  since: IsoDateTime,
  /** A path on the volume that was measured: the GOAT home. */
  path: TrimmedNonEmptyString,
  availableBytes: NonNegativeInt,
  totalBytes: NonNegativeInt,
});
export type HostDiskPressure = typeof HostDiskPressure.Type;

export const HostPressureDelivery = Schema.Literals(["wake", "notice", "off"]);
export type HostPressureDelivery = typeof HostPressureDelivery.Type;

export const HostPressureAdmission = Schema.Literals(["warn", "block", "off"]);
export type HostPressureAdmission = typeof HostPressureAdmission.Type;

/** Server settings key `fleet.pressure`. Every field falls back to DEFAULT_HOST_PRESSURE_SETTINGS. */
export const HostPressureSettings = Schema.Struct({
  /** Default true. False stops classification, notices and launch warnings. */
  enabled: Schema.optional(Schema.Boolean),
  elevatedLoadPerCore: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  criticalLoadPerCore: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  /** Whole-host CPU busy percent (0-100). */
  elevatedCpuPercent: Schema.optional(
    Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
  ),
  /**
   * GOAT server event-loop stalls are counted over ten minutes, never one alone: three of at least
   * half this are elevated, two of at least this are critical. One stall of three times this is
   * critical at once.
   */
  criticalEventLoopDelayMs: Schema.optional(PositiveInt),
  elevatedMemoryFreePercent: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  criticalMemoryFreePercent: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  /**
   * Disk levels need free space under both limits of that level: the GiB limit keeps a large disk
   * quiet while hundreds of GiB remain, the percent limit keeps a small one (a 64 GiB cloud
   * machine) from warning while it is half empty. A host that does not report its disk size is
   * judged on the GiB limits alone.
   */
  elevatedDiskFreeGiB: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  criticalDiskFreeGiB: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  elevatedDiskFreePercent: Schema.optional(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100)),
  ),
  criticalDiskFreePercent: Schema.optional(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100)),
  ),
  /** How long a load, CPU, memory or disk reading must hold before the level rises. */
  sustainMs: Schema.optional(PositiveInt),
  /** How long every reading must stay clear before the level falls. */
  recoverMs: Schema.optional(PositiveInt),
  /**
   * A host gets at most one new timeline notice per thread in this window; later changes update
   * that notice in place. A rise to a wake level wakes threads at most once per level in it.
   */
  notifyCooldownMs: Schema.optional(PositiveInt),
  /** How orchestrating threads hear about each level. */
  elevatedDelivery: Schema.optional(HostPressureDelivery),
  criticalDelivery: Schema.optional(HostPressureDelivery),
  /** What goat_thread_launch, goat_ssh_thread_launch and delegate_task do on a critical host. */
  admission: Schema.optional(HostPressureAdmission),
});
export type HostPressureSettings = typeof HostPressureSettings.Type;

export const DEFAULT_HOST_PRESSURE_SETTINGS = {
  enabled: true,
  elevatedLoadPerCore: 1.5,
  criticalLoadPerCore: 3,
  elevatedCpuPercent: 90,
  criticalEventLoopDelayMs: 5_000,
  elevatedMemoryFreePercent: 10,
  criticalMemoryFreePercent: 5,
  elevatedDiskFreeGiB: 50,
  criticalDiskFreeGiB: 15,
  elevatedDiskFreePercent: 15,
  criticalDiskFreePercent: 5,
  sustainMs: 3 * 60_000,
  recoverMs: 5 * 60_000,
  notifyCooldownMs: 45 * 60_000,
  elevatedDelivery: "notice",
  criticalDelivery: "wake",
  admission: "warn",
} as const satisfies Required<HostPressureSettings>;

/** What a launch onto a pressured host returns next to its normal result. */
export const HostPressureAdvice = Schema.Struct({
  host: Schema.NullOr(TrimmedNonEmptyString),
  level: Schema.Literals(["elevated", "critical"]),
  message: Schema.String,
  /** Hosts with room, best first, from the last status this machine read. Null is this machine. */
  alternatives: Schema.Array(Schema.NullOr(TrimmedNonEmptyString)),
});
export type HostPressureAdvice = typeof HostPressureAdvice.Type;

/** goat_host_status `placement`: what a new lane needs. Omitted fields do not filter. */
export const HostPlacementRequirements = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  driver: Schema.optional(ProviderDriverKind),
  /** process.platform the lane needs: linux, darwin or win32. */
  platform: Schema.optional(TrimmedNonEmptyString),
});
export type HostPlacementRequirements = typeof HostPlacementRequirements.Type;

export const HostPlacementCandidate = Schema.Struct({
  host: Schema.NullOr(TrimmedNonEmptyString),
  eligible: Schema.Boolean,
  /** Lower is better. Null for a host that was skipped. */
  score: Schema.NullOr(Schema.Number),
  pressure: Schema.Literals(["ok", "elevated", "critical", "unknown"]),
  reasons: Schema.Array(Schema.String),
});
export type HostPlacementCandidate = typeof HostPlacementCandidate.Type;

export const HostPlacementRanking = Schema.Struct({
  /** Eligible hosts best first, then the skipped ones with why. */
  candidates: Schema.Array(HostPlacementCandidate),
  suggestion: Schema.String,
});
export type HostPlacementRanking = typeof HostPlacementRanking.Type;
