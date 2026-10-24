import type {
  HostCompatibility,
  HostStatusEntry,
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
    return [
      {
        instanceId: provider.instanceId,
        driver: provider.driver,
        ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
        limits: provider.usageLimits,
        fromCache: !refreshed.has(provider.instanceId),
      },
    ];
  });
}
