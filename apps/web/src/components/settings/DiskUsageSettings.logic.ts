import {
  STORAGE_CLEAN_MAX_ITEMS,
  type HostDiskPressure,
  type HostDiskUsage,
  type HostPressureLevel,
  type StorageCleanItem,
  type StorageCleanResult,
  type StorageItem,
  type StorageItemKind,
} from "@goat/contracts";

import { formatBytes } from "~/lib/formatBytes";

/** In the order the breakdown lists them: what usually takes the most space first. */
export const STORAGE_KIND_LABELS: Readonly<Record<StorageItemKind, string>> = {
  worktree: "Worktrees",
  build_output: "Build outputs in worktrees",
  orphan_folder: "Leftover folders",
  stale_registration: "Missing worktrees git still lists",
  runtime_version: "GOAT runtimes",
  rotated_logs: "Rotated logs",
  temp: "Temporary folders",
  attachments: "Files of deleted threads",
  kache: "kache build cache",
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

export function diskSummary(
  disk: HostDiskUsage | null,
  pressure: HostDiskPressure | null,
): { readonly text: string; readonly level: HostPressureLevel | null } {
  const reading = pressure ?? disk;
  if (reading === null || reading.totalBytes <= 0)
    return { text: "Free space not reported", level: null };
  const percent = Math.round((reading.availableBytes / reading.totalBytes) * 100);
  return {
    text:
      formatBytes(reading.availableBytes) +
      " free of " +
      formatBytes(reading.totalBytes) +
      " (" +
      percent +
      "%)",
    level: pressure?.level ?? null,
  };
}

export const STORAGE_STATE_LABELS = {
  removable: "Can be removed",
  needs_attention: "Needs attention",
  protected: "In use",
  report_only: "Shown only",
} as const satisfies Record<StorageItem["state"], string>;
