import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HandoffSummary } from "./handoff.ts";
import { HostDiskUsage } from "./hostStatus.ts";
import { OrchestratorMcpHost } from "./orchestratorMcp.ts";

/**
 * What GOAT's own folders hold on one machine, and the person-confirmed cleanup of the parts that
 * are safe to remove (docs/user, Storage). Every item names the exact path a cleanup would delete.
 */

export const StorageItemKind = Schema.Literals([
  /** A git worktree in this server's worktrees folder that no live thread uses. */
  "worktree",
  /** A folder in the worktrees folder that is no registered checkout and no thread references. */
  "orphan_folder",
  /** Git still lists worktrees of one repository whose folders are gone. */
  "stale_registration",
  /** node_modules or a Rust target/ inside a GOAT worktree. */
  "build_output",
  "runtime_version",
  "rotated_logs",
  "temp",
  /** Files deleted threads left behind; offered only while nothing surviving mentions their thread. */
  "attachments",
  /** The kache build cache. Report only: kache keeps it under its own size limit. */
  "kache",
]);
export type StorageItemKind = typeof StorageItemKind.Type;

export const StorageItemState = Schema.Literals([
  /** Cleanup may delete it after confirmation. */
  "removable",
  /** Holds work or could not be checked; cleanup never deletes it. */
  "needs_attention",
  /** In use: the running runtime, a worktree a thread uses. */
  "protected",
  "report_only",
]);
export type StorageItemState = typeof StorageItemState.Type;

export const StorageItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: StorageItemKind,
  path: TrimmedNonEmptyString,
  label: Schema.String,
  /** Bytes deleting it would free; null when the scan could not measure it in time. */
  bytes: Schema.NullOr(NonNegativeInt),
  state: StorageItemState,
  /** Part of the default selection: removable and in a category that is safe to clear. */
  selected: Schema.Boolean,
  reason: Schema.String,
  /**
   * Identity of what was scanned (file identity, branch and commit, or the set of missing
   * paths). Cleanup refuses an item whose token no longer matches, so a confirmation never
   * covers something that changed after the person looked at it.
   */
  token: TrimmedNonEmptyString,
  /** Worktrees: what their build outputs hold, such as "node_modules 1.2 GB". */
  detail: Schema.optional(Schema.String),
});
export type StorageItem = typeof StorageItem.Type;

export const StorageUsageReport = Schema.Struct({
  scannedAt: IsoDateTime,
  durationMs: NonNegativeInt,
  disk: Schema.NullOr(HostDiskUsage),
  items: Schema.Array(StorageItem),
  /** What limited this scan, such as folders it ran out of time to measure. */
  notes: Schema.Array(Schema.String),
});
export type StorageUsageReport = typeof StorageUsageReport.Type;

export const StorageCleanItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
});
export type StorageCleanItem = typeof StorageCleanItem.Type;

/** Items one cleanup request may name; an approval lists every path it covers. */
export const STORAGE_CLEAN_MAX_ITEMS = 200;

export const StorageCleanItems = Schema.Array(StorageCleanItem).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(STORAGE_CLEAN_MAX_ITEMS),
);

export const StorageCleanInput = Schema.Struct({ items: StorageCleanItems });
export type StorageCleanInput = typeof StorageCleanInput.Type;

export const StorageCleanOutcome = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: StorageItemKind,
  path: TrimmedNonEmptyString,
  outcome: Schema.Literals(["removed", "skipped", "failed"]),
  reason: Schema.String,
  /** What the item measured before it was removed; null when unknown. */
  bytes: Schema.NullOr(NonNegativeInt),
});
export type StorageCleanOutcome = typeof StorageCleanOutcome.Type;

export const StorageCleanResult = Schema.Struct({
  results: Schema.Array(StorageCleanOutcome),
  freedBytes: NonNegativeInt,
  /** Where every deletion is recorded on that machine. */
  logPath: Schema.String,
});
export type StorageCleanResult = typeof StorageCleanResult.Type;

export class StorageReclaimError extends Schema.TaggedError<StorageReclaimError>()(
  "StorageReclaimError",
  { message: Schema.String },
) {}

export const ServerGetStorageUsageInput = Schema.Struct({
  /** Scan again even when a recent scan is cached. */
  rescan: Schema.optional(Schema.Boolean),
});
export type ServerGetStorageUsageInput = typeof ServerGetStorageUsageInput.Type;

export const StorageMcpUsageInput = Schema.Struct({
  host: Schema.optional(OrchestratorMcpHost),
  rescan: Schema.optional(
    Schema.Boolean.annotate({
      description: "Scan now instead of returning a scan from the last few minutes.",
    }),
  ),
});
export type StorageMcpUsageInput = typeof StorageMcpUsageInput.Type;

export const StorageMcpUsageResult = Schema.Struct({
  ...StorageUsageReport.fields,
  host: Schema.optional(Schema.String),
});
export type StorageMcpUsageResult = typeof StorageMcpUsageResult.Type;

export const StorageMcpCleanInput = Schema.Struct({
  items: Schema.optional(
    StorageCleanItems.annotate({
      description:
        "Items to delete, each {id, token} exactly as goat_storage_usage or a dry run listed it. A dry run without items previews the default selection.",
    }),
  ),
  dryRun: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Default true: list what would be deleted. false deletes, after a person approves.",
    }),
  ),
  approvalId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "What a person approved for exactly these items: the handoffId a thread got, or the decision id GOAT filed for another client.",
    }),
  ),
});
export type StorageMcpCleanInput = typeof StorageMcpCleanInput.Type;

export const StorageMcpCleanResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("preview"),
    items: Schema.Array(StorageItem),
    bytes: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("needs_human"),
    handoff: HandoffSummary,
    next: Schema.Struct({
      after: Schema.Literal("approval"),
      call: Schema.Literal("goat_storage_clean"),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("cleaned"),
    ...StorageCleanResult.fields,
  }),
]);
export type StorageMcpCleanResult = typeof StorageMcpCleanResult.Type;

/** MCP success schema: HandoffSummary holds a DateTime that must encode as JSON. */
export const StorageMcpCleanResultJson = Schema.toCodecJson(StorageMcpCleanResult);
