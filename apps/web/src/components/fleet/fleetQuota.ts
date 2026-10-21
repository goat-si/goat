import type { HostStatusQuota, QuotaPool, QuotaWindow } from "@goat/contracts";

import { quotaRows, type FleetHostRow, type FleetQuotaRow } from "./fleetTelemetry";

export interface FleetConsoleQuota extends Omit<FleetQuotaRow, "driver" | "peak"> {
  readonly peak: number | null;
  readonly detail?: string;
  readonly hidden: number;
}

function knownWindows(windows: ReadonlyArray<QuotaWindow>) {
  return windows.flatMap((window) =>
    window.usedPercent === undefined ? [] : [{ ...window, usedPercent: window.usedPercent }],
  );
}

function windowDetail(windows: ReadonlyArray<QuotaWindow>): string {
  return knownWindows(windows)
    .map(
      (window) =>
        `${window.label}${window.scopeModel === undefined ? "" : ` (${window.scopeModel})`}: ${Math.round(window.usedPercent)}% (${window.source})` +
        (window.resetsAt === undefined ? "" : `, resets ${window.resetsAt}`),
    )
    .join(" · ");
}

function matchesProvider(quota: HostStatusQuota, provider: QuotaPool["providers"][number]) {
  return (
    quota.driver === provider.provider ||
    (quota.driver === "codex" && provider.provider === "openai") ||
    (quota.driver === "claudeAgent" && provider.provider === "anthropic") ||
    provider.accounts.some((account) => account.driver === quota.driver)
  );
}

/** The newest Home snapshot is authoritative; merging older windows could resurrect unknown data. */
export function fleetQuota(rows: ReadonlyArray<FleetHostRow>, maxWindows = 2) {
  const homes = new Map<string, QuotaPool>();
  const homeLabels = new Map<string, string>();
  for (const row of rows) {
    const pool = row.entry?.metrics?.quotaPool;
    if (pool === undefined) continue;
    const id = pool.producer.homeId;
    if (pool.producer.role !== "client") {
      // A Child relay returns the Home's producer too. Only the actual Home's row can name it.
      if (row.key === id || row.label === id || row.entry?.host === id)
        homeLabels.set(id, row.label);
    }
    const previous = homes.get(id);
    if (previous === undefined || previous.generatedAt < pool.generatedAt) {
      homes.set(id, pool);
    }
  }

  const viaHub = new Map<string, string>();
  const routed = new Map<string, Map<string, HostStatusQuota>>();
  const localRows = rows.map((row) => {
    const metrics = row.entry?.metrics;
    if (metrics === undefined) return row;
    const explicit = metrics.quotas.some((quota) => quota.limits.quotaPool !== undefined);
    const homeId = metrics.quotaPool?.producer.homeId;
    const quotas = metrics.quotas.filter((quota) => {
      const reference = quota.limits.quotaPool;
      const inferred =
        !explicit && metrics.quotaPool?.providers.find((p) => matchesProvider(quota, p));
      const id = reference?.homeId ?? (inferred ? homeId : undefined);
      if (id === undefined) return true;
      const provider = reference?.provider ?? (inferred ? inferred.provider : undefined);
      if (provider === undefined) return true;
      let providers = routed.get(id);
      if (providers === undefined) routed.set(id, (providers = new Map()));
      const previous = providers.get(provider);
      if (previous === undefined || previous.limits.checkedAt < quota.limits.checkedAt) {
        providers.set(provider, quota);
      }
      viaHub.set(row.key, homeLabels.get(id) ?? id);
      return false;
    });
    if (homeId !== undefined) viaHub.set(row.key, homeLabels.get(homeId) ?? homeId);
    return { ...row, entry: { ...row.entry!, metrics: { ...metrics, quotas } } };
  });

  const pools: FleetConsoleQuota[] = [];
  for (const homeId of new Set([...homes.keys(), ...routed.keys()])) {
    const pool = homes.get(homeId);
    const windows: FleetQuotaRow["windows"][number][] = [];
    const detail: string[] = [];
    let accountCount = 0;
    if (pool !== undefined) {
      for (const provider of pool.providers) {
        windows.push(
          ...knownWindows(provider.pooled.windows).map((window) => ({
            id: JSON.stringify([provider.provider, window.id]),
            label:
              pool.providers.length === 1 ? window.label : `${provider.provider} ${window.label}`,
            usedPercent: window.usedPercent,
          })),
        );
        detail.push(
          `${provider.provider}: ${windowDetail(provider.pooled.windows) || "Quota unknown"}`,
        );
        if (provider.pooled.headroom !== undefined)
          detail.push(`Headroom: ${provider.pooled.headroom}`);
        if (provider.pooled.nextResetAt !== undefined)
          detail.push(`Next reset: ${provider.pooled.nextResetAt}`);
        const accounts = new Map(provider.accounts.map((account) => [account.accountRef, account]));
        accountCount += accounts.size;
        for (const account of accounts.values()) {
          detail.push(
            `${account.label ?? account.accountRef} (${account.state}): ${windowDetail(account.windows) || "Quota unknown"}`,
          );
        }
      }
    } else {
      for (const [provider, quota] of routed.get(homeId) ?? []) {
        windows.push(
          ...quota.limits.windows.map((window) => ({
            id: JSON.stringify([provider, window.id]),
            label: `${provider} ${window.label}`,
            usedPercent: window.usedPercent,
          })),
        );
      }
      detail.push(
        ...windows.map((window) => `${window.label}: ${Math.round(window.usedPercent)}%`),
      );
    }
    const sorted = windows.toSorted((a, b) => b.usedPercent - a.usedPercent);
    const hiddenWindows = Math.max(0, windows.length - maxWindows);
    const hidden = hiddenWindows + accountCount;
    pools.push({
      key: JSON.stringify(["opencodex", homeId]),
      label: "OpenCodex pool",
      host: homeLabels.get(homeId) ?? homeId,
      windows: sorted.slice(0, maxWindows),
      peak: sorted[0]?.usedPercent ?? null,
      hidden,
      detail: [
        `OpenCodex pool · ${homeLabels.get(homeId) ?? homeId}`,
        `${hiddenWindows} more ${hiddenWindows === 1 ? "window" : "windows"} · ${accountCount} ${accountCount === 1 ? "account" : "accounts"}`,
        ...detail,
      ].join("\n"),
    });
  }
  const quotas: FleetConsoleQuota[] = [
    ...pools,
    ...quotaRows(localRows, maxWindows).map((row) => ({ ...row, hidden: 0 })),
  ];
  return { quotas, viaHub };
}
