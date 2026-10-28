import type {
  HostCompatibility,
  HostStatusEntry,
  HostStatusMetrics,
  HostStatusProvider,
  HostStatusQuota,
  HostThreadCounts,
  RuntimeProtocolRanges,
  ServerProvider,
  ServerProviderUsageLimits,
} from "@goat/contracts";
import { GoatHostStatusResult, ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { hostCompatibilityOf, ownRuntimeProtocolRanges } from "@goat/shared/sshRuntimeProtocol";

import packageJson from "../../package.json" with { type: "json" };

/** Active work this machine should show. Archived, deleted, and subagent threads are omitted. */
export interface HostThreadCountSource {
  readonly deletedAt: unknown;
  readonly archivedAt: unknown;
  readonly lineage: { readonly relationshipToParent: string | null };
  readonly activityRunStatus?: "preparing" | "starting" | "running" | "waiting" | null | undefined;
  readonly status: string;
  readonly pendingRuntimeRequest?: unknown;
}

const RUNNING = new Set(["preparing", "starting", "running"]);

/** Subagent threads running a turn, which `countHostThreads` leaves out of its display counts. */
export function runningSubagents(threads: ReadonlyArray<HostThreadCountSource>): number {
  return threads.filter(
    (thread) =>
      thread.deletedAt == null &&
      thread.archivedAt == null &&
      thread.lineage.relationshipToParent === "subagent" &&
      (RUNNING.has(thread.activityRunStatus ?? "") || RUNNING.has(thread.status)),
  ).length;
}

/**
 * Turns a runtime restart would interrupt on a host: top-level and subagent. Undefined when the
 * host predates `subagentsRunning`, because it cannot show its children are idle.
 */
export function interruptibleTurns(threads: HostThreadCounts): number | undefined {
  return threads.subagentsRunning === undefined
    ? undefined
    : threads.running + threads.subagentsRunning;
}

export function countHostThreads(threads: ReadonlyArray<HostThreadCountSource>): HostThreadCounts {
  const counts = { running: 0, waiting: 0, queued: 0 };
  for (const thread of threads) {
    if (thread.deletedAt != null || thread.archivedAt != null) continue;
    if (thread.lineage.relationshipToParent === "subagent") continue;
    const activity = thread.activityRunStatus ?? null;
    if (
      activity === "waiting" ||
      thread.status === "waiting" ||
      thread.pendingRuntimeRequest != null
    ) {
      counts.waiting += 1;
    } else if (RUNNING.has(activity ?? "") || RUNNING.has(thread.status)) {
      counts.running += 1;
    } else if (thread.status === "queued") {
      counts.queued += 1;
    }
  }
  return counts;
}

/** A remote GOAT that answered, but does not implement this tool. */
export function isUnsupportedHostStatusMessage(message: string): boolean {
  return /tool ['"]goat_host_status['"] not found|does not have goat_host_status/i.test(message);
}

export function clipHostStatusMessage(message: string): string {
  return Array.from(message).slice(0, 500).join("");
}

const OPTIONAL_METRIC_SECTIONS = [
  "platform",
  "providers",
  "quotaPool",
  "computerUse",
  "opencodex",
  "storage",
  "strays",
] as const satisfies ReadonlyArray<keyof HostStatusMetrics>;

/** Top-level optional fields on a host entry that a newer or odd host can fill with non-JSON values. */
const OPTIONAL_ENTRY_FIELDS = [
  "protocol",
  "compatibility",
  "parity",
  "opencodexUpdate",
  "opencodexChild",
  "goatclaw",
] as const satisfies ReadonlyArray<keyof HostStatusEntry>;

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === null ||
    prototype === Object.prototype ||
    Object.getPrototypeOf(prototype) === null
  );
};

/**
 * First reason `value` is not a JSON value, or undefined when it is. Only the objects on the
 * path from the root to the current value count as ancestors, so a value that is referenced
 * twice is fine and only a real cycle is reported.
 */
function jsonProblem(value: unknown, path: string): string | undefined {
  const ancestors = new Set<object>();
  const visit = (current: unknown, at: string): string | undefined => {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return undefined;
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? undefined : `${at} is not a finite number`;
    }
    if (typeof current === "undefined") return `${at} is undefined`;
    if (typeof current === "bigint") return `${at} is a bigint`;
    if (typeof current !== "object") return `${at} is ${typeof current}`;
    if (ancestors.has(current)) return `${at} is cyclic`;
    if (!Array.isArray(current) && !isPlainObject(current)) return `${at} is not a plain object`;
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        for (let index = 0; index < current.length; index += 1) {
          const problem = visit(current[index], `${at}.${index}`);
          if (problem !== undefined) return problem;
        }
        return undefined;
      }
      for (const key of Object.keys(current)) {
        const problem = visit(
          (current as Record<string, unknown>)[key],
          at.length === 0 ? key : `${at}.${key}`,
        );
        if (problem !== undefined) return problem;
      }
      return undefined;
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value, path);
}

/**
 * Copy of `value` without own properties whose value is undefined. Returns the same reference
 * when nothing changed. Arrays keep their elements, and cycles and odd objects are left for
 * `jsonProblem` to report.
 */
function withoutUndefinedProperties(value: unknown, ancestors: Set<object> = new Set()): unknown {
  if (typeof value !== "object" || value === null || ancestors.has(value)) return value;
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) return value;
  ancestors.add(value);
  try {
    if (isArray) {
      let next: unknown[] | undefined;
      value.forEach((item, index) => {
        const cleaned = withoutUndefinedProperties(item, ancestors);
        if (cleaned === item) return;
        next ??= [...value];
        next[index] = cleaned;
      });
      return next ?? value;
    }
    let next: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        next ??= { ...value };
        delete next[key];
        continue;
      }
      const cleaned = withoutUndefinedProperties(item, ancestors);
      if (cleaned === item) continue;
      next ??= { ...value };
      next[key] = cleaned;
    }
    return next ?? value;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Keeps a host entry encodable. Optional top-level fields lose their undefined keys, and a
 * field that is still not JSON is dropped. Metrics sections that are not JSON are dropped. Every
 * drop is named on `omittedMetrics`, so one bad value must not make the tool refuse the host. A
 * required metrics field that is still not JSON drops `metrics`.
 */
export function omitUnencodableMetrics(entry: HostStatusEntry): HostStatusEntry {
  const dropped: Array<{ section: string; message: string }> = [];
  const next: Record<string, unknown> = { ...entry };
  let changed = false;
  for (const field of OPTIONAL_ENTRY_FIELDS) {
    if (!Object.hasOwn(entry, field)) continue;
    const original = entry[field];
    if (original === undefined) {
      delete next[field];
      changed = true;
      continue;
    }
    const cleaned = withoutUndefinedProperties(original);
    const problem = jsonProblem(cleaned, field);
    if (problem !== undefined) {
      delete next[field];
      dropped.push({ section: field, message: clipHostStatusMessage(problem) });
      changed = true;
    } else if (cleaned !== original) {
      next[field] = cleaned;
      changed = true;
    }
  }
  const metrics = entry.metrics;
  let nextMetrics: Record<string, unknown> | undefined;
  let metricsProblem: string | undefined;
  let metricsChanged = false;
  if (metrics !== undefined) {
    nextMetrics = { ...metrics };
    for (const section of OPTIONAL_METRIC_SECTIONS) {
      if (!Object.hasOwn(metrics, section)) continue;
      const problem = jsonProblem(metrics[section], section);
      if (problem === undefined) continue;
      delete nextMetrics[section];
      dropped.push({ section, message: clipHostStatusMessage(problem) });
      metricsChanged = true;
      changed = true;
    }
    metricsProblem = jsonProblem(nextMetrics, "metrics");
    if (metricsProblem !== undefined) {
      dropped.push({ section: "metrics", message: clipHostStatusMessage(metricsProblem) });
      delete next.metrics;
      changed = true;
    } else if (metricsChanged) {
      next.metrics = nextMetrics;
    }
  }
  if (!changed) return entry;
  if (dropped.length === 0) return next as HostStatusEntry;
  return {
    ...(next as HostStatusEntry),
    omittedMetrics: [...(entry.omittedMetrics ?? []), ...dropped],
  };
}

const UNSUPPORTED_MESSAGE = (host: string) =>
  `GOAT on ${host} does not offer goat_host_status. Update GOAT on that machine.`;

/** The remote answered for itself (`host: null`). Tag that entry with the SSH alias. */
export function tagRemoteHostStatus(result: GoatHostStatusResult, host: string): HostStatusEntry {
  const entry = result.hosts.find((candidate) => candidate.host === null) ?? result.hosts[0];
  if (entry === undefined) {
    return {
      host,
      reachability: "unreachable",
      message: `${host} returned no host status.`,
    };
  }
  return { ...entry, host };
}

export function unsupportedHostStatus(host: string): HostStatusEntry {
  return {
    host,
    reachability: "unsupported",
    message: UNSUPPORTED_MESSAGE(host),
  };
}

const formatRanges = (protocol: RuntimeProtocolRanges) => {
  const range = ({ min, max }: { readonly min: number; readonly max: number }) =>
    min === max ? `${min}` : `${min}-${max}`;
  return `orchestration ${range(protocol.orchestration)}, SSH ${range(protocol.ssh)}`;
};

export interface LocalHostCompatibility {
  readonly version: string;
  readonly speaks: RuntimeProtocolRanges;
}

/** This machine reads every host as a client, so it compares the protocols it speaks. */
export const LOCAL_HOST_COMPATIBILITY: LocalHostCompatibility = {
  version: packageJson.version,
  speaks: ownRuntimeProtocolRanges(ORCHESTRATION_PROTOCOL_VERSION),
};

/**
 * The ADR-0019 verdict on a reachable remote, shared by host status and the provider host matrix
 * so both warn alike. `versionMismatch` still marks a different build (or none reported) for older
 * readers; only an incompatible or unprovable host gets a warning message.
 */
export function judgeRemoteHost(
  remote: {
    readonly host: string;
    readonly serverVersion?: string | undefined;
    readonly protocol?: RuntimeProtocolRanges | undefined;
  },
  local: LocalHostCompatibility,
): { versionMismatch?: true; compatibility: HostCompatibility; message?: string } {
  const verdict = hostCompatibilityOf(local.speaks, remote);
  const marked = {
    ...(remote.serverVersion === local.version ? {} : { versionMismatch: true as const }),
    compatibility: verdict.compatibility,
  };
  const build =
    remote.serverVersion === undefined
      ? "an older GOAT that does not report its version"
      : `GOAT ${remote.serverVersion}`;
  const here = `this machine runs GOAT ${local.version} (${formatRanges(local.speaks)})`;
  switch (verdict.compatibility) {
    case "compatible":
      return marked;
    case "degraded":
      return {
        ...marked,
        message: `${remote.host} runs ${build}, which does not report the protocols it serves, so compatibility with this machine cannot be confirmed. It still answers; update GOAT on ${remote.host} to confirm the rest.`,
      };
    case "incompatible":
      return {
        ...marked,
        message: `${remote.host} runs ${build}, serving ${remote.protocol === undefined ? "unknown protocols" : formatRanges(remote.protocol)}; ${here}. They cannot work together. Update GOAT on ${verdict.update === "this-machine" ? "this machine" : remote.host}.`,
      };
  }
}

export function markHostCompatibility(
  entry: HostStatusEntry,
  local: LocalHostCompatibility,
): HostStatusEntry {
  if (entry.reachability !== "ok" || entry.host === null) return entry;
  const { message: _remoteMessage, ...rest } = entry;
  return { ...rest, ...judgeRemoteHost({ ...entry, host: entry.host }, local) };
}

export function unreachableHostStatus(
  host: string | null,
  message: string,
  previous: HostStatusEntry | undefined,
): HostStatusEntry {
  const metrics = previous?.reachability === "ok" ? previous.metrics : undefined;
  return {
    host,
    reachability: "unreachable",
    ...(metrics === undefined ? {} : { lastKnown: true as const, metrics }),
    message: clipHostStatusMessage(message),
  };
}

/** How long a status read waits before probing provider CLIs again. */
export const HOST_STATUS_QUOTA_REFRESH_INTERVAL_MS = 60_000;

export function quotaRefreshDue(
  limits: ServerProviderUsageLimits | undefined,
  nowMs: number,
  intervalMs: number,
): boolean {
  if (limits === undefined || limits.unavailable?.reason === "unsupported") return false;
  const checkedAt = Date.parse(limits.checkedAt);
  if (!Number.isFinite(checkedAt)) return true;
  return nowMs - checkedAt >= intervalMs;
}

export function hostStatusProviders(
  providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "driver" | "displayName" | "enabled">
  >,
): Array<HostStatusProvider> {
  return providers.map((provider) => ({
    instanceId: provider.instanceId,
    driver: provider.driver,
    ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
    enabled: provider.enabled,
  }));
}

export function hostStatusQuotas(
  providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "driver" | "displayName" | "usageLimits">
  >,
  refreshed: ReadonlySet<string>,
): Array<HostStatusQuota> {
  return providers.flatMap((provider) => {
    if (provider.usageLimits === undefined) return [];
    const note = quotaPoolNote(provider.usageLimits);
    return [
      {
        instanceId: provider.instanceId,
        driver: provider.driver,
        ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
        limits: provider.usageLimits,
        fromCache: !refreshed.has(provider.instanceId),
        ...(note === undefined ? {} : { note }),
      },
    ];
  });
}

/** Agents otherwise read a pool percentage as the limit of the instance's own login. */
function quotaPoolNote(limits: ServerProviderUsageLimits): string | undefined {
  const pool = limits.quotaPool;
  if (pool === undefined) {
    if (limits.quotaPoolRoute === undefined) return undefined;
    return (
      `Routes through OpenCodex for ${limits.quotaPoolRoute.provider}, but GOAT could not read the pool` +
      (limits.unavailable?.message === undefined ? "." : `: ${limits.unavailable.message}`) +
      " Its own account limit is not shown."
    );
  }
  const accounts =
    pool.accounts === undefined
      ? ""
      : ` ${pool.accounts.available} of ${pool.accounts.total} accounts available.`;
  const readings =
    limits.windows.length === 0
      ? "The pool reports no readings."
      : limits.windows
          .map(
            (window) =>
              `${window.label} ${Math.round(window.usedPercent)}%` +
              (window.source === undefined ? "" : ` (${window.source})`),
          )
          .join(", ") + ".";
  return `OpenCodex pool for ${pool.provider} on Home ${pool.homeId}:${accounts} ${readings} These are the pool's limits, not this instance's own account.`;
}
