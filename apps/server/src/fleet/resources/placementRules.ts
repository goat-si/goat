/**
 * Placement's filter step: every (host, model) candidate is refused with a reason or kept, and
 * the survivors are scored by channelPlacement's choosePlacement, the one scorer.
 *
 * Caps bind goal work only; a person's own launch is never refused by them
 * (docs/internals/agentic-k8s.md, "Resources and placement").
 *
 * @module placementRules
 */
import {
  FLEET_LOCAL_HOST_KEY,
  type FleetSettings,
  type HostStatusEntry,
  type HostStatusQuota,
  type ModelSelection,
  type PlacementHostRefusal,
  type PlacementRefusal,
  type SchedulerHostStatus,
  type QuotaPool,
} from "@goat/contracts";

import {
  busiestWindow,
  choosePlacement,
  isExhausted,
  placementWindows,
  type PlacementCandidate,
} from "../../channels/channelPlacement.ts";

export interface HostSelector {
  readonly hosts?: ReadonlyArray<string | null> | undefined;
  readonly exclude?: ReadonlyArray<string | null> | undefined;
}

export interface PlacementInput {
  /** "goal:<id>" or "thread:<id>". */
  readonly owner: string;
  /** The requested model first, then the fallback chain's other steps. */
  readonly selections: ReadonlyArray<ModelSelection>;
  readonly hostSelector: HostSelector;
  readonly avoidHosts: ReadonlyArray<string | null>;
  /**
   * The host whose environment holds the project, when the work names one: projects are
   * environment-local, so no other host can run it. Undefined when the work brings a cwd.
   */
  readonly projectHost?: string | null | undefined;
  /** From the health controller once it lands; empty until then. */
  readonly cordoned: ReadonlySet<string | null>;
}

export type PlacementResult =
  | {
      readonly _tag: "Placed";
      readonly host: string | null;
      readonly modelSelection: ModelSelection;
      readonly reason: string | undefined;
    }
  | { readonly _tag: "Refused"; readonly reasons: ReadonlyArray<PlacementHostRefusal> };

const hostKey = (host: string | null) => host ?? FLEET_LOCAL_HOST_KEY;
const isGoal = (owner: string) => owner.startsWith("goal:");
const refusal = (code: PlacementRefusal["code"], message: string): PlacementRefusal => ({
  code,
  message,
});

/** Running plus queued threads on one host that answered just now; null when it did not. */
const hostThreads = (entry: HostStatusEntry) =>
  entry.reachability === "ok" && entry.lastKnown !== true && entry.metrics !== undefined
    ? entry.metrics.threads.running + entry.metrics.threads.queued
    : null;

export const fleetThreads = (hosts: ReadonlyArray<HostStatusEntry>) =>
  hosts.reduce((total, entry) => total + (hostThreads(entry) ?? 0), 0);

/** Why this host takes no work from this owner, or undefined when it may. */
function hostRefusal(
  entry: HostStatusEntry,
  settings: FleetSettings,
  input: Pick<PlacementInput, "owner" | "hostSelector" | "avoidHosts" | "cordoned" | "projectHost">,
  fleetThreadCount: number,
): PlacementRefusal | undefined {
  const selected = input.hostSelector.hosts;
  if (
    (selected !== undefined && !selected.includes(entry.host)) ||
    input.hostSelector.exclude?.includes(entry.host) === true ||
    input.avoidHosts.includes(entry.host)
  )
    return refusal("excluded", "outside the host selector");
  if (input.projectHost !== undefined && input.projectHost !== entry.host)
    return refusal("no_project", "the project lives on " + (input.projectHost ?? "this machine"));
  if (entry.reachability !== "ok")
    return refusal(
      "not_ready",
      entry.reachability === "unsupported" ? "does not report host status" : "unreachable",
    );
  if (entry.lastKnown === true || entry.metrics === undefined)
    return refusal("not_ready", "status is stale");
  if (input.cordoned.has(entry.host)) return refusal("cordoned", "cordoned");
  if (!isGoal(input.owner)) return undefined;
  const limits = settings.hosts?.[hostKey(entry.host)];
  if (limits?.allowGoals === false) return refusal("goals_not_allowed", "takes no goal work");
  const threads = hostThreads(entry) ?? 0;
  if (limits?.maxThreads != null && threads >= limits.maxThreads)
    return refusal("host_cap", "at its limit of " + limits.maxThreads + " threads");
  if (settings.maxRunningThreads != null && fleetThreadCount >= settings.maxRunningThreads)
    return refusal(
      "global_cap",
      "fleet at its limit of " + settings.maxRunningThreads + " threads",
    );
  return undefined;
}

/** An instance with no usage limits reported has no windows, so it is never exhausted. */
const quotaCandidate = <A>(
  value: A,
  quota: Pick<HostStatusQuota, "instanceId" | "displayName"> & {
    readonly limits?: HostStatusQuota["limits"];
  },
  host: string | null,
  activeTasks: number,
  preferred: boolean,
  model?: string,
  pool?: QuotaPool,
): PlacementCandidate<A> => ({
  value,
  host,
  providerLabel: quota.displayName ?? quota.instanceId,
  preferred,
  model,
  quotaPool:
    pool?.producer.homeId === quota.limits?.quotaPool?.homeId
      ? pool?.providers.find((provider) => provider.provider === quota.limits?.quotaPool?.provider)
      : undefined,
  windows:
    quota.limits === undefined || quota.limits.windows.length === 0
      ? null
      : quota.limits.windows.map((window) => ({
          label: window.label,
          usedPercent: window.usedPercent,
          ...(window.scopeModel === undefined ? {} : { scopeModel: window.scopeModel }),
          ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
        })),
  activeTasks,
});

const nextReset = (candidate: PlacementCandidate<unknown>, now: number) =>
  placementWindows(candidate)
    .filter((window) => window.usedPercent >= 100 && window.resetsAt !== undefined)
    .map((window) => window.resetsAt!)
    .filter((resetsAt) => Date.parse(resetsAt) > now)
    .toSorted()[0];

interface Choice {
  readonly host: string | null;
  readonly modelSelection: ModelSelection;
}

export function place(
  input: PlacementInput,
  hosts: ReadonlyArray<HostStatusEntry>,
  settings: FleetSettings,
  now: number,
): PlacementResult {
  const total = fleetThreads(hosts);
  const reasons: Array<PlacementHostRefusal> = [];
  const candidates: Array<PlacementCandidate<Choice>> = [];
  for (const entry of hosts) {
    const refused = hostRefusal(entry, settings, input, total);
    if (refused !== undefined) {
      if (refused.code !== "excluded") reasons.push({ host: entry.host, reason: refused });
      continue;
    }
    const metrics = entry.metrics!;
    let kept = false;
    let first: PlacementRefusal | undefined;
    input.selections.forEach((modelSelection, index) => {
      const quota = metrics.quotas.find((item) => item.instanceId === modelSelection.instanceId);
      // Hosts that predate `providers` list only the instances that report quota.
      const instance =
        metrics.providers === undefined
          ? quota
          : metrics.providers.find((item) => item.instanceId === modelSelection.instanceId);
      if (instance === undefined) {
        first ??= refusal("no_instance", modelSelection.instanceId + " is not configured there");
        return;
      }
      if ("enabled" in instance && !instance.enabled) {
        first ??= refusal("no_instance", modelSelection.instanceId + " is disabled there");
        return;
      }
      const candidate = quotaCandidate(
        { host: entry.host, modelSelection },
        quota ?? instance,
        entry.host,
        hostThreads(entry) ?? 0,
        index === 0,
        modelSelection.model,
        metrics.quotaPool,
      );
      if (isExhausted(candidate, now)) {
        const resetsAt = nextReset(candidate, now);
        first ??= refusal(
          "quota_exhausted",
          modelSelection.instanceId +
            " is at its usage limit" +
            (resetsAt === undefined ? "" : " until " + resetsAt),
        );
        return;
      }
      kept = true;
      candidates.push(candidate);
    });
    if (!kept && first !== undefined) reasons.push({ host: entry.host, reason: first });
  }
  const placed = choosePlacement(candidates, now);
  if (placed === undefined) return { _tag: "Refused", reasons };
  return {
    _tag: "Placed",
    host: placed.chosen.value.host,
    modelSelection: placed.chosen.value.modelSelection,
    reason: placed.reason,
  };
}

/** One host's row in goat_scheduler_status: counts and limits, and why goal work would be refused. */
export function schedulerHostStatus(
  entry: HostStatusEntry,
  settings: FleetSettings,
  cordoned: ReadonlySet<string | null>,
  fleetThreadCount: number,
  now: number,
): SchedulerHostStatus {
  const limits = settings.hosts?.[hostKey(entry.host)];
  const metrics = entry.metrics;
  const refused = hostRefusal(
    entry,
    settings,
    { owner: "goal:status", hostSelector: {}, avoidHosts: [], cordoned },
    fleetThreadCount,
  );
  return {
    host: entry.host,
    reachability: entry.lastKnown === true ? "stale" : entry.reachability,
    running: metrics?.threads.running ?? null,
    queued: metrics?.threads.queued ?? null,
    maxThreads: limits?.maxThreads ?? null,
    allowGoals: limits?.allowGoals !== false,
    quotas: (metrics?.quotas ?? []).map((quota) => {
      const candidate = quotaCandidate(
        null,
        quota,
        entry.host,
        0,
        false,
        undefined,
        metrics?.quotaPool,
      );
      const resetsAt = nextReset(candidate, now);
      return {
        instanceId: quota.instanceId,
        busiestPercent: busiestWindow(candidate)?.usedPercent ?? null,
        exhausted: isExhausted(candidate, now),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      };
    }),
    refusals: refused === undefined ? [] : [refused],
  };
}
