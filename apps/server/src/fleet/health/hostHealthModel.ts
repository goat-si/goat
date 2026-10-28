import type { HostCondition, HostStatusEntry } from "@goat/contracts";
import { verdictWindows } from "@goat/shared/quotaVerdict";
import * as DateTime from "effect/DateTime";

import { isExhausted } from "../../channels/channelPlacement.ts";
import { OUTAGE_NOTICE_FAILURES, type LaunchWatchOutage } from "../../mcp/launchWatch.ts";

/**
 * Host conditions from signals that already exist (goat_host_status answers, thread status reads,
 * launch-watch outages), free of I/O. The table in docs/internals/agentic-k8s.md "Host conditions"
 * is the spec: Ready within 3 min of a contact, Unknown after that, Unreachable after
 * OUTAGE_NOTICE_FAILURES failed contacts in a row, Lost once Unreachable for hostLostAfterMs.
 *
 * Sleep on this machine is not evidence about other hosts. Failures seen across a gap in our own
 * clock ticks, while suspended, or within wakeGraceMs after waking are dropped, so a Mac waking
 * from sleep never makes a host Lost (ssh-reconnect.md covers the reconnect itself).
 */
export const HOST_HEALTH_THRESHOLDS = {
  readyWithinMs: 3 * 60_000,
  unreachableFailures: OUTAGE_NOTICE_FAILURES,
  hostLostAfterMs: 300_000,
  probeIntervalMs: 60_000,
  sleepGapMs: 2 * 60_000,
  wakeGraceMs: 5 * 60_000,
} as const;
export type HostHealthThresholds = typeof HOST_HEALTH_THRESHOLDS;

export interface HostContact {
  readonly lastOkAt: number | null;
  readonly failures: number;
  /** When the failures reached the Unreachable count. */
  readonly unreachableSince: number | null;
  readonly lastError: string | null;
  /** The last goat_host_status answer, for versions and quotas. */
  readonly sample: HostStatusEntry | null;
}

export const emptyContact: HostContact = {
  lastOkAt: null,
  failures: 0,
  unreachableSince: null,
  lastError: null,
  sample: null,
};

export interface MonitorClock {
  readonly lastTickAt: number | null;
  /** Failures before this instant are not counted: this machine was asleep. */
  readonly quietUntil: number;
  readonly wokeAt: number | null;
}

export const initialClock: MonitorClock = { lastTickAt: null, quietUntil: 0, wokeAt: null };

/** Advances the clock on each scheduler tick; woke means failures so far must be dropped. */
export function observeTick(
  clock: MonitorClock,
  now: number,
  suspended: boolean,
  thresholds: HostHealthThresholds = HOST_HEALTH_THRESHOLDS,
): { readonly clock: MonitorClock; readonly woke: boolean } {
  const gap = clock.lastTickAt === null ? 0 : now - clock.lastTickAt;
  const woke = suspended || gap >= thresholds.sleepGapMs;
  return {
    woke,
    clock: woke
      ? { lastTickAt: now, quietUntil: now + thresholds.wakeGraceMs, wokeAt: now }
      : { ...clock, lastTickAt: now },
  };
}

export const forgetFailures = (contact: HostContact): HostContact =>
  contact.failures === 0 ? contact : { ...contact, failures: 0, unreachableSince: null };

/** A successful contact; a host status answer also refreshes the sample. */
export const recordAnswer = (
  contact: HostContact,
  now: number,
  sample?: HostStatusEntry,
): HostContact => ({
  lastOkAt: now,
  failures: 0,
  unreachableSince: null,
  lastError: null,
  sample: sample ?? contact.sample,
});

export function recordFailure(
  contact: HostContact,
  now: number,
  error: string,
  clock: MonitorClock,
  thresholds: HostHealthThresholds = HOST_HEALTH_THRESHOLDS,
): HostContact {
  if (now < clock.quietUntil) return contact;
  const failures = contact.failures + 1;
  return {
    ...contact,
    failures,
    unreachableSince:
      contact.unreachableSince ?? (failures >= thresholds.unreachableFailures ? now : null),
    lastError: error,
  };
}

/** One goat_host_status entry. "unsupported" still answered, so it counts as contact. */
export const recordSample = (
  contact: HostContact,
  entry: HostStatusEntry,
  now: number,
  clock: MonitorClock,
): HostContact =>
  entry.reachability === "unreachable"
    ? recordFailure(contact, now, entry.message ?? "unreachable", clock)
    : recordAnswer(contact, now, entry);

/**
 * A launch watch's outage is the same evidence from the watch follower. It counts only when it
 * began after this machine's wake grace and after the host last answered.
 */
export function recordOutage(
  contact: HostContact,
  outage: LaunchWatchOutage,
  now: number,
  clock: MonitorClock,
  thresholds: HostHealthThresholds = HOST_HEALTH_THRESHOLDS,
): HostContact {
  if (clock.wokeAt !== null && outage.since < clock.quietUntil) return contact;
  if (contact.lastOkAt !== null && outage.since <= contact.lastOkAt) return contact;
  if (outage.failures <= contact.failures) return contact;
  return {
    ...contact,
    failures: outage.failures,
    unreachableSince:
      contact.unreachableSince ?? (outage.failures >= thresholds.unreachableFailures ? now : null),
    lastError: outage.lastError,
  };
}

export const isUnreachable = (
  contact: HostContact,
  thresholds: HostHealthThresholds = HOST_HEALTH_THRESHOLDS,
) => contact.failures >= thresholds.unreachableFailures;

export const isLost = (
  contact: HostContact,
  now: number,
  thresholds: HostHealthThresholds = HOST_HEALTH_THRESHOLDS,
) =>
  isUnreachable(contact, thresholds) &&
  contact.unreachableSince !== null &&
  now - contact.unreachableSince >= thresholds.hostLostAfterMs;

export interface HostScheduling {
  readonly cordoned: boolean;
  readonly draining: boolean;
  readonly reason: string | null;
  readonly changedAt: string;
}

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export function deriveConditions(input: {
  readonly contact: HostContact;
  readonly scheduling: HostScheduling | null;
  readonly now: number;
  readonly thresholds?: HostHealthThresholds;
}): Array<HostCondition> {
  const { contact, scheduling, now } = input;
  const thresholds = input.thresholds ?? HOST_HEALTH_THRESHOLDS;
  const conditions: Array<HostCondition> = [];
  if (isUnreachable(contact, thresholds)) {
    const since = contact.unreachableSince ?? now;
    const message =
      contact.failures + " failed contacts in a row; last: " + (contact.lastError ?? "");
    conditions.push({ type: "Unreachable", since: iso(since), message });
    if (isLost(contact, now, thresholds)) {
      conditions.push({
        type: "Lost",
        since: iso(since + thresholds.hostLostAfterMs),
        message: "Unreachable for " + Math.round((now - since) / 60_000) + " minutes.",
      });
    }
  } else if (contact.lastOkAt !== null && now - contact.lastOkAt <= thresholds.readyWithinMs) {
    conditions.push({ type: "Ready", since: iso(contact.lastOkAt), message: "Answered recently." });
  } else {
    conditions.push({
      type: "Unknown",
      since: iso(contact.lastOkAt ?? now),
      message:
        contact.lastOkAt === null ? "Not contacted yet." : "No contact in the last 3 minutes.",
    });
  }
  if (scheduling?.cordoned === true) {
    conditions.push({
      type: "Cordoned",
      since: scheduling.changedAt,
      message: scheduling.reason ?? "No new goal placements.",
    });
  }
  if (scheduling?.draining === true) {
    conditions.push({
      type: "Draining",
      since: scheduling.changedAt,
      message: "Goal attempts move off this host after their current run.",
    });
  }
  const sample = contact.sample;
  // Since host status judges protocols (#497), only a host that cannot prove or does not have
  // compatibility warrants a condition; different compatible builds are routine.
  const verdict =
    sample?.compatibility ?? (sample?.versionMismatch === true ? "degraded" : "compatible");
  if (verdict !== "compatible") {
    conditions.push({
      type: "VersionMismatch",
      since: iso(contact.lastOkAt ?? now),
      reason: verdict,
      message: sample?.message ?? "Runs a different GOAT version.",
    });
  }
  for (const quota of sample?.metrics?.quotas ?? []) {
    // No model: a model-scoped window never makes the whole host's quota look exhausted.
    const candidate = {
      value: null,
      host: sample?.host ?? null,
      providerLabel: quota.instanceId,
      preferred: false,
      windows: verdictWindows(quota.limits),
      activeTasks: 0,
    };
    if (!isExhausted(candidate, now)) continue;
    conditions.push({
      type: "QuotaExhausted",
      since: iso(contact.lastOkAt ?? now),
      instanceId: quota.instanceId,
      message: quota.instanceId + " is at its usage limit.",
    });
  }
  return conditions;
}

/**
 * New or moved work may go here. Quotas and a degraded version are warnings; a host that cannot
 * work with this machine (compatibility "incompatible") takes no work.
 */
export const isSchedulable = (conditions: ReadonlyArray<HostCondition>) =>
  conditions.some((condition) => condition.type === "Ready") &&
  !conditions.some(
    (condition) =>
      condition.type === "Unreachable" ||
      condition.type === "Cordoned" ||
      condition.type === "Draining" ||
      (condition.type === "VersionMismatch" && condition.reason === "incompatible"),
  );
