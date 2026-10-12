import type {
  HostStatusEntry,
  HostStatusQuota,
  HostThreadCounts,
  ServerProvider,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { GoatHostStatusResult } from "@t3tools/contracts";

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
  return /tool ['"]goat_host_status['"] not found/i.test(message);
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
