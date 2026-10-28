import type {
  EnvironmentId,
  ServerProvider,
  ServerProviderUsageAvailability,
  ServerProviderUsageWindow,
} from "@goat/contracts";

import { formatDuration, type LimitPresentations } from "./usageLimits.ts";

/** One OpenCodex pool as Usage shows it: the pool's own readings beside the accounts it counts. */
export interface OpenCodexPoolLine {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly homeId: string;
  readonly checkedAt: string;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly availability: ReadonlyArray<ServerProviderUsageAvailability>;
  readonly accounts: {
    readonly available: number;
    readonly total: number;
    /** Paused or reauth accounts, which the pool leaves out; unknown without the Home's snapshot. */
    readonly excluded?: number | undefined;
  };
  readonly environments: ReadonlyArray<EnvironmentId>;
}

export function collectOpenCodexPools(
  presentations: LimitPresentations,
): ReadonlyArray<OpenCodexPoolLine> {
  const lines = new Map<string, OpenCodexPoolLine>();
  for (const [environmentId, presentation] of presentations) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      const limits = provider.usageLimits;
      const pool = limits?.quotaPool;
      if (!provider.enabled || limits === undefined || pool === undefined) continue;
      const key = JSON.stringify([pool.homeId, pool.provider]);
      const previous = lines.get(key);
      const environments = [...new Set([...(previous?.environments ?? []), environmentId])];
      if (
        previous !== undefined &&
        Date.parse(previous.checkedAt) >= Date.parse(limits.checkedAt)
      ) {
        lines.set(key, { ...previous, environments });
        continue;
      }
      lines.set(key, {
        key,
        driver: provider.driver,
        homeId: pool.homeId,
        checkedAt: limits.checkedAt,
        windows: limits.windows,
        availability: limits.availability ?? [],
        accounts: {
          available: pool.accounts?.available ?? 0,
          total: pool.accounts?.total ?? 0,
          excluded: excludedAccounts(presentations, pool.homeId, provider.driver),
        },
        environments,
      });
    }
  }
  return [...lines.values()];
}

/** Counted from the Home's newest snapshot, the one that decides membership and state. */
function excludedAccounts(
  presentations: LimitPresentations,
  homeId: string,
  driver: ServerProvider["driver"],
) {
  let newest: { readonly checkedAt: string; readonly excluded: number } | undefined;
  for (const presentation of presentations.values()) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.homeId !== homeId) continue;
      if (newest !== undefined && Date.parse(newest.checkedAt) >= Date.parse(source.checkedAt))
        continue;
      newest = {
        checkedAt: source.checkedAt,
        excluded: source.accounts.filter(
          (account) =>
            account.driver === driver && (account.state === "paused" || account.state === "reauth"),
        ).length,
      };
    }
  }
  return newest?.excluded;
}

/** A pool-wide block as a sentence; it never reads as a percentage. */
export function availabilityText(block: ServerProviderUsageAvailability, now: number): string {
  const resets = block.resetsAt === undefined ? Number.NaN : Date.parse(block.resetsAt);
  return (
    "All accounts blocked" +
    (block.scopeModel === undefined ? "" : ` for ${block.scopeModel.replace(/^family:/, "")}`) +
    (Number.isFinite(resets)
      ? resets > now
        ? ` · resets in ${formatDuration(resets - now)}`
        : " · resets now"
      : "")
  );
}
