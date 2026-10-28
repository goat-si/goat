import {
  quotaWindowToAvailability,
  type HostStatusMetrics,
  type HostStatusQuota,
  type QuotaPool,
  type QuotaWindow,
  type ServerProviderUsageAvailability,
} from "@goat/contracts";

import { quotaRows, type FleetHostRow, type FleetQuotaRow } from "./fleetTelemetry";

export interface FleetConsoleQuota extends Omit<FleetQuotaRow, "driver" | "peak"> {
  readonly peak: number | null;
  readonly detail?: string;
  readonly hidden: number;
  /** What the hidden count stands for, such as "+1 window · 2 accounts". */
  readonly hiddenLabel?: string;
  /** Replaces "Quota unknown" when the pool's state is known, such as an unreadable pool. */
  readonly status?: string;
  /** Hosts matched to this pool by driver alone, because they report no route markers. */
  readonly inferred?: ReadonlyArray<string>;
}

const plural = (count: number, word: string) => count + " " + word + (count === 1 ? "" : "s");

/** A pool-wide block has no percentage; it reads as a sentence, never as 100%. */
function blockDetail(prefix: string, blocks: ReadonlyArray<ServerProviderUsageAvailability>) {
  return blocks
    .filter((block) => block.exhausted)
    .map(
      (block) =>
        prefix +
        "all accounts blocked" +
        (block.scopeModel === undefined ? "" : " for " + block.scopeModel) +
        (block.resetsAt === undefined ? "" : " until " + block.resetsAt),
    );
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

function displayName(value: string | undefined, homeId: string): string | null {
  const name = value?.trim() ?? "";
  return name.length > 0 && name !== homeId ? name : null;
}

// Missing display metadata must never turn an opaque Home identity into a visible name.
const inventoryHomeName = (metrics: HostStatusMetrics | undefined, homeId: string) =>
  displayName(metrics?.opencodex?.link.homeName, homeId);

/** The newest Home snapshot is authoritative; merging older windows could resurrect unknown data. */
export function fleetQuota(rows: ReadonlyArray<FleetHostRow>, maxWindows = 2) {
  const homes = new Map<string, QuotaPool>();
  const homeLabels = new Map<string, { name: string; sampledAt: number }>();
  for (const row of rows) {
    const metrics = row.entry?.metrics;
    const pool = metrics?.quotaPool;
    const ids = new Set(
      pool === undefined
        ? metrics?.quotas.flatMap((quota) =>
            quota.limits.quotaPool === undefined ? [] : [quota.limits.quotaPool.homeId],
          )
        : [pool.producer.homeId],
    );
    if (ids.size === 1) {
      for (const id of ids) {
        const name = inventoryHomeName(metrics, id);
        const previous = homeLabels.get(id);
        if (
          name !== null &&
          (previous === undefined || (metrics?.sampledAt ?? 0) > previous.sampledAt)
        ) {
          homeLabels.set(id, { name, sampledAt: metrics?.sampledAt ?? 0 });
        }
      }
    }
    if (pool === undefined) continue;
    const id = pool.producer.homeId;
    const previous = homes.get(id);
    if (previous === undefined || previous.generatedAt < pool.generatedAt) {
      homes.set(id, pool);
    }
  }

  const homeName = (id: string) =>
    homeLabels.get(id)?.name ?? displayName(homes.get(id)?.producer.displayName, id);
  const viaHub = new Map<string, string | null>();
  /** Rows whose pool routing is a driver guess, and those rows' labels per Home, keyed by row. */
  const inferredRows = new Set<string>();
  const inferredHosts = new Map<string, Map<string, string>>();
  const routed = new Map<string, Map<string, HostStatusQuota>>();
  const unreadable: FleetConsoleQuota[] = [];
  const localRows = rows.map((row) => {
    const metrics = row.entry?.metrics;
    if (metrics === undefined) return row;
    const explicit =
      metrics.quotaRouteMarkers === true ||
      metrics.quotas.some(
        (quota) =>
          quota.limits.quotaPool !== undefined || quota.limits.quotaPoolRoute !== undefined,
      );
    const homeId = metrics.quotaPool?.producer.homeId;
    const quotas = metrics.quotas.filter((quota) => {
      const reference = quota.limits.quotaPool;
      const route = quota.limits.quotaPoolRoute;
      // A routed instance whose pool could not be read shows that, never its own login's quota.
      if (
        route !== undefined &&
        reference === undefined &&
        quota.limits.unavailable !== undefined
      ) {
        unreadable.push({
          key: JSON.stringify(["opencodex-unavailable", row.key, quota.instanceId]),
          label: "OpenCodex pool",
          host: row.label,
          windows: [],
          peak: null,
          hidden: 0,
          status:
            "pool unavailable" +
            (route.openCodexVersion === undefined
              ? ""
              : " (OpenCodex " + route.openCodexVersion + ")"),
          detail: [quota.displayName ?? quota.instanceId, quota.limits.unavailable.message]
            .filter((line) => line !== undefined)
            .join("\n"),
        });
        return false;
      }
      // Hosts that predate route references publish neither marker; only their rows are guessed.
      const inferred =
        !explicit &&
        quota.limits.unavailable === undefined &&
        metrics.quotaPool?.providers.find((p) => matchesProvider(quota, p));
      const id = reference?.homeId ?? (inferred ? homeId : undefined);
      if (id === undefined) return true;
      const provider = reference?.provider ?? (inferred ? inferred.provider : undefined);
      if (provider === undefined) return true;
      if (reference === undefined) {
        inferredRows.add(row.key);
        let hosts = inferredHosts.get(id);
        if (hosts === undefined) inferredHosts.set(id, (hosts = new Map()));
        hosts.set(row.key, row.label);
      }
      let providers = routed.get(id);
      if (providers === undefined) routed.set(id, (providers = new Map()));
      const previous = providers.get(provider);
      if (previous === undefined || previous.limits.checkedAt < quota.limits.checkedAt) {
        providers.set(provider, quota);
      }
      viaHub.set(row.key, homeName(id));
      return false;
    });
    if (homeId !== undefined) viaHub.set(row.key, homeName(homeId));
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
        detail.push(
          ...blockDetail(
            provider.provider + ": ",
            provider.pooled.windows.flatMap((window) => quotaWindowToAvailability(window) ?? []),
          ),
        );
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
        ...[...(routed.get(homeId) ?? [])].flatMap(([provider, quota]) =>
          blockDetail(provider + ": ", quota.limits.availability ?? []),
        ),
      );
    }
    const sorted = windows.toSorted((a, b) => b.usedPercent - a.usedPercent);
    const hiddenWindows = Math.max(0, windows.length - maxWindows);
    const hidden = hiddenWindows + accountCount;
    const inferred = [...(inferredHosts.get(homeId)?.values() ?? [])];
    pools.push({
      key: JSON.stringify(["opencodex", homeId]),
      label: "OpenCodex pool",
      host: homeName(homeId),
      windows: sorted.slice(0, maxWindows),
      peak: sorted[0]?.usedPercent ?? null,
      hidden,
      ...(inferred.length === 0 ? {} : { inferred }),
      hiddenLabel:
        "+" +
        [hiddenWindows > 0 ? plural(hiddenWindows, "window") : "", plural(accountCount, "account")]
          .filter((part) => part.length > 0)
          .join(" · "),
      detail: [
        "OpenCodex pool" + (homeName(homeId) === null ? "" : ` · ${homeName(homeId)}`),
        `${hiddenWindows} more ${hiddenWindows === 1 ? "window" : "windows"} · ${accountCount} ${accountCount === 1 ? "account" : "accounts"}`,
        ...detail,
        ...(inferred.length === 0
          ? []
          : [
              `Quota routing inferred for ${inferred.join(", ")}: ${inferred.length === 1 ? "this host did" : "these hosts did"} not report which instances use this pool, so Fleet matched them by provider driver. Hosts on an older GOAT report it after an update.`,
            ]),
      ].join("\n"),
    });
  }
  const quotas: FleetConsoleQuota[] = [
    ...pools,
    ...unreadable,
    ...quotaRows(localRows, maxWindows).map((row) => ({ ...row, hidden: 0 })),
  ];
  return { quotas, viaHub, inferredRows };
}
