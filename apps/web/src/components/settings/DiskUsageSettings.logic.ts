import { msg } from "gt-react";
import {
  STORAGE_CLEAN_MAX_ITEMS,
  type HostDiskPressure,
  type HostDiskUsage,
  type StorageCleanItem,
  type StorageCleanResult,
  type StorageItem,
  type StorageItemKind,
} from "@goat/contracts";

import { formatBytes } from "~/lib/formatBytes";

/** In the order the breakdown lists them: what usually takes the most space first. */
export const STORAGE_KIND_LABELS: Readonly<Record<StorageItemKind, string>> = {
  worktree: msg("Worktrees"),
  build_output: msg("Build outputs in worktrees"),
  orphan_folder: msg("Leftover folders"),
  stale_registration: msg("Missing worktrees git still lists"),
  runtime_version: msg("GOAT runtimes"),
  rotated_logs: msg("Rotated logs"),
  temp: msg("Temporary folders"),
  attachments: msg("Files of deleted threads"),
  kache: msg("kache build cache"),
};

export interface StorageKindTotal {
  readonly kind: StorageItemKind;
  readonly label: string;
  readonly count: number;
  /** Known bytes; items the scan could not measure add nothing. */
  readonly bytes: number;
  readonly removableBytes: number;
}

/** Paths shown below a grouped item before the person confirms deletion. */
export const confirmationFiles = (item: StorageItem) =>
  item.files?.map((file) => ({ path: file.path, size: formatBytes(file.bytes) })) ?? [];

export function storageTotals(items: ReadonlyArray<StorageItem>): ReadonlyArray<StorageKindTotal> {
  return (Object.keys(STORAGE_KIND_LABELS) as ReadonlyArray<StorageItemKind>).flatMap((kind) => {
    const ofKind = items.filter((item) => item.kind === kind);
    if (ofKind.length === 0) return [];
    return [
      {
        kind,
        label: STORAGE_KIND_LABELS[kind],
        count: ofKind.length,
        bytes: ofKind.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
        removableBytes: ofKind
          .filter((item) => item.state === "removable")
          .reduce((sum, item) => sum + (item.bytes ?? 0), 0),
      },
    ];
  });
}

/** What the cleanup starts with: removable items in the categories that are safe to clear. */
export const initialSelection = (items: ReadonlyArray<StorageItem>): ReadonlySet<string> =>
  new Set(
    items.filter((item) => item.state === "removable" && item.selected).map((item) => item.id),
  );

/** Only removable items count, whatever else a stale selection holds. */
export function selectionSummary(items: ReadonlyArray<StorageItem>, selected: ReadonlySet<string>) {
  const chosen = items.filter((item) => item.state === "removable" && selected.has(item.id));
  return {
    items: chosen,
    count: chosen.length,
    bytes: chosen.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
    unmeasured: chosen.filter((item) => item.bytes === null).length,
  };
}

/** The ticked items as requests the server accepts, in order: each names at most its limit. */
export function cleanupBatches(
  items: ReadonlyArray<Pick<StorageItem, "id" | "token">>,
): ReadonlyArray<ReadonlyArray<StorageCleanItem>> {
  const batches: Array<ReadonlyArray<StorageCleanItem>> = [];
  for (let start = 0; start < items.length; start += STORAGE_CLEAN_MAX_ITEMS)
    batches.push(
      items.slice(start, start + STORAGE_CLEAN_MAX_ITEMS).map(({ id, token }) => ({ id, token })),
    );
  return batches;
}

/** One result for every request that finished; null when none did. */
export function mergeCleanResults(
  results: ReadonlyArray<StorageCleanResult>,
): StorageCleanResult | null {
  const last = results.at(-1);
  if (last === undefined) return null;
  return {
    results: results.flatMap((result) => result.results),
    freedBytes: results.reduce((sum, result) => sum + result.freedBytes, 0),
    logPath: last.logPath,
  };
}

/** The largest worktrees first, unmeasured ones last. */
export const largestWorktrees = (items: ReadonlyArray<StorageItem>, limit: number) =>
  items
    .filter((item) => item.kind === "worktree")
    .toSorted((left, right) => (right.bytes ?? -1) - (left.bytes ?? -1))
    .slice(0, limit);

export function diskSummary(disk: HostDiskUsage | null, pressure: HostDiskPressure | null) {
  const reading = pressure ?? disk;
  if (reading === null || reading.totalBytes <= 0) return null;
  return {
    free: formatBytes(reading.availableBytes),
    total: formatBytes(reading.totalBytes),
    percent: Math.round((reading.availableBytes / reading.totalBytes) * 100),
    level: pressure?.level ?? null,
  };
}

export const STORAGE_STATE_LABELS = {
  removable: msg("Can be removed"),
  needs_attention: msg("Needs attention"),
  protected: msg("In use"),
  report_only: msg("Shown only"),
} as const satisfies Record<StorageItem["state"], string>;

export function storageRelativeTime(isoDate: string, locale: string, nowMs = Date.now()) {
  const elapsed = nowMs - Date.parse(isoDate);
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  if (minutes === 0) return format.format(0, "second");
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? format.format(-hours, "hour") : format.format(-Math.floor(hours / 24), "day");
}
