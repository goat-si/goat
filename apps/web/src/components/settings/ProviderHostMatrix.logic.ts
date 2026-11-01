import type {
  ProviderHostRow,
  ProviderHostSyncDriver,
  ProviderSyncHostPhase,
  ProviderSyncState,
} from "@goat/contracts";

export const SYNC_PROVIDERS = [
  { driver: "codex", displayName: "Codex" },
  { driver: "claudeAgent", displayName: "Claude" },
  { driver: "cursor", displayName: "Cursor" },
  { driver: "grok", displayName: "Grok" },
  { driver: "opencode", displayName: "OpenCode" },
  { driver: "pi", displayName: "Pi" },
] as const satisfies ReadonlyArray<{ driver: ProviderHostSyncDriver; displayName: string }>;

export function machineColumns(rows: ReadonlyArray<ProviderHostRow>) {
  return rows.toSorted((a, b) => Number(b.host === null) - Number(a.host === null));
}

function hostUnavailableReason(row: ProviderHostRow) {
  const labels = {
    ok: null,
    update_runtime: "Update runtime",
    not_ready: "Prepare host",
    unreachable: "Unreachable",
  };
  return labels[row.status];
}

export function providerCell(row: ProviderHostRow, driver: ProviderHostSyncDriver) {
  const unavailable = hostUnavailableReason(row);
  if (unavailable) return { version: unavailable, auth: null, message: row.message };
  const provider = row.providers.find((entry) => entry.driver === driver);
  return {
    version: provider?.installed
      ? (provider.version ?? "Installed · version unknown")
      : "Not installed",
    auth:
      provider?.auth === "signed_in"
        ? "Signed in"
        : provider?.auth === "signed_out"
          ? "Signed out"
          : "Unknown",
    message: undefined,
  };
}

export function syncHostChoices(
  rows: ReadonlyArray<ProviderHostRow>,
  driver: ProviderHostSyncDriver,
) {
  return rows.flatMap((row) =>
    row.host === null
      ? []
      : [
          {
            host: row.host,
            disabled: row.status !== "ok",
            reason: [hostUnavailableReason(row), row.message].filter(Boolean).join(" · "),
            missing: !row.providers.some(
              (provider) => provider.driver === driver && provider.installed,
            ),
          },
        ],
  );
}

export function defaultSyncHosts(
  rows: ReadonlyArray<ProviderHostRow>,
  driver: ProviderHostSyncDriver,
  initialHosts?: ReadonlyArray<string>,
) {
  return syncHostChoices(rows, driver)
    .filter(
      (host) => !host.disabled && (initialHosts ? initialHosts.includes(host.host) : host.missing),
    )
    .slice(0, 16)
    .map((host) => host.host);
}

export function matchableLocalVersion(
  rows: ReadonlyArray<ProviderHostRow>,
  driver: ProviderHostSyncDriver,
) {
  const local = rows.find((row) => row.host === null && row.status === "ok");
  const provider = local?.providers.find((entry) => entry.driver === driver && entry.installed);
  const version = provider?.version;
  return version &&
    /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z]{1,20}(?:\.[0-9A-Za-z]{1,20}){0,4})?$/u.test(version)
    ? version
    : null;
}

export const SYNC_PHASE_LABELS = {
  queued: "Queued",
  installing: "Installing",
  installed: "Installed",
  signing_in: "Signing in",
  signed_in: "Signed in",
  failed: "Failed",
  cancelled: "Cancelled",
  update_runtime: "Update runtime",
} as const satisfies Record<ProviderSyncHostPhase, string>;

export function syncSummary(sync: Pick<ProviderSyncState, "hosts" | "login">) {
  const succeeded = sync.hosts.filter(
    (host) => host.phase === "signed_in" || (!sync.login && host.phase === "installed"),
  ).length;
  const failed = sync.hosts.filter(
    (host) => host.phase === "failed" || host.phase === "update_runtime",
  ).length;
  const cancelled = sync.hosts.filter((host) => host.phase === "cancelled").length;
  return `${succeeded} of ${sync.hosts.length} machines synced${failed ? ` · ${failed} need attention` : ""}${cancelled ? ` · ${cancelled} cancelled` : ""}.`;
}

export function safeLoginUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
