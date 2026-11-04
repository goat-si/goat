import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import {
  ORCHESTRATION_HISTORY_ARCHIVE_AFTER_DAYS,
  ORCHESTRATION_HISTORY_BUDGET_BYTES,
} from "./memory.ts";

export const StorageRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
);
export const SettledWorktreeRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3650 })),
);
/** How many of the most recently used managed worktrees retention keeps; null keeps all. */
export const WorktreeKeepRecent = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
);
export const DEFAULT_WORKTREE_KEEP_RECENT = 15;
export const DEFAULT_WORKTREE_AFTER_DAYS = 7;
export const DEFAULT_WORKTREE_SNAPSHOT_DAYS = 30;
export const HistoryBudgetBytes = Schema.Int.check(
  Schema.isBetween({ minimum: 268435456, maximum: 1099511627776 }),
);

export const WorktreeKeepWhen = Schema.Literals([
  "any-local-files",
  "uncommitted-changes",
  "tracked-changes",
]);
export type WorktreeKeepWhen = typeof WorktreeKeepWhen.Type;

export const WorktreeCleanupRules = Schema.Struct({
  worktreeKeepWhen: WorktreeKeepWhen.pipe(
    Schema.withDecodingDefault(Effect.succeed("uncommitted-changes")),
  ),
  worktreeAfterDays: StorageRetentionDays,
  worktreeSettledAfterDays: SettledWorktreeRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeOnMerge: Schema.Boolean,
  worktreeOnDelete: Schema.Boolean,
  worktreeUnchanged: Schema.Boolean,
  // Custom rules saved before these existed keep their old behavior.
  worktreeOnArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeSnapshotChanges: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeKeepRecent: WorktreeKeepRecent.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type WorktreeCleanupRules = typeof WorktreeCleanupRules.Type;

export const WorktreeCleanup = Schema.NullOr(
  Schema.Union([
    Schema.Struct({ mode: Schema.Literal("off") }),
    Schema.Struct({ mode: Schema.Literal("custom"), rules: WorktreeCleanupRules }),
  ]),
);
export type WorktreeCleanup = typeof WorktreeCleanup.Type;

/**
 * Automatic worktree removal starts only after a person saw this preview (activatesAt, a day
 * later) or confirmed it. SSH-provisioned servers never start on their own: activatesAt stays null.
 */
export const WorktreeCleanupPreview = Schema.Struct({
  /** A response names the preview it answers; a larger planned set starts a new preview. */
  id: Schema.String,
  plannedCount: Schema.Number,
  startedAt: Schema.String,
  seenAt: Schema.NullOr(Schema.String),
  activatesAt: Schema.NullOr(Schema.String),
  requiresConfirmation: Schema.Boolean,
});
export type WorktreeCleanupPreview = typeof WorktreeCleanupPreview.Type;

export const StorageCleanupReportEntry = Schema.Struct({
  kind: Schema.Literals(["worktree", "browser-artifacts", "logs"]),
  outcome: Schema.Literals(["removed", "kept", "failed"]),
  reason: Schema.String,
  path: Schema.NullOr(Schema.String),
  projectPath: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  threadId: Schema.NullOr(ThreadId),
  threadTitle: Schema.NullOr(Schema.String),
  bytes: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  files: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The refs/goat/snapshots ref saved before a worktree was removed. */
  snapshotRef: Schema.optionalKey(Schema.String),
  /** A kept worktree that cleanup will remove once its preview is confirmed; older clients see "kept". */
  planned: Schema.optionalKey(Schema.Boolean),
});
export type StorageCleanupReportEntry = typeof StorageCleanupReportEntry.Type;
export const StorageCleanupReport = Schema.Struct({
  trigger: Schema.Literals(["automatic", "manual"]),
  startedAt: Schema.String,
  finishedAt: Schema.String,
  entries: Schema.Array(StorageCleanupReportEntry),
  counts: Schema.Struct({ removed: Schema.Number, kept: Schema.Number, failed: Schema.Number }),
  omittedCount: Schema.Number,
  bytesFreed: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Set while automatic worktree removal awaits its first-run preview; no worktree was removed. */
  worktreePreview: Schema.optionalKey(WorktreeCleanupPreview),
});
export type StorageCleanupReport = typeof StorageCleanupReport.Type;

export const StorageCleanupSettings = Schema.Struct({
  worktreeKeepWhen: WorktreeKeepWhen.pipe(
    Schema.withDecodingDefault(Effect.succeed("uncommitted-changes")),
  ),
  worktreeAfterDays: StorageRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKTREE_AFTER_DAYS)),
  ),
  worktreeSettledAfterDays: SettledWorktreeRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeOnDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  worktreeUnchanged: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeOnArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * With a verified snapshot, uncommitted and untracked changes no longer keep a worktree when
   * worktreeKeepWhen is "uncommitted-changes" or "tracked-changes". "any-local-files" and off
   * keep worktreeKeepWhen's meaning exactly.
   */
  worktreeSnapshotChanges: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  worktreeKeepRecent: WorktreeKeepRecent.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKTREE_KEEP_RECENT)),
  ),
  /** Days a removed worktree's snapshot ref is kept; null keeps it until its thread is deleted. */
  worktreeSnapshotDays: StorageRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_WORKTREE_SNAPSHOT_DAYS)),
  ),
  browserArtifactsAfterDays: StorageRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  logsAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Above this, compaction trims bulky tool output in threads idle for a week, oldest first. */
  historyBudgetBytes: HistoryBudgetBytes.pipe(
    Schema.withDecodingDefault(Effect.succeed(ORCHESTRATION_HISTORY_BUDGET_BYTES)),
  ),
  /**
   * Threads idle this many days keep their messages in the database and move tool calls,
   * output and reasoning to a compressed archive that is restored when the thread is opened.
   * Null keeps every thread in the database.
   */
  historyArchiveAfterDays: StorageRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(ORCHESTRATION_HISTORY_ARCHIVE_AFTER_DAYS)),
  ),
  /** Archives older than this many days are deleted for good. Null, the default, keeps them. */
  historyArchiveDeleteAfterDays: StorageRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type StorageCleanupSettings = typeof StorageCleanupSettings.Type;

export const WorktreeCleanupPatch = Schema.NullOr(
  Schema.Union([
    Schema.Struct({ mode: Schema.Literal("off") }),
    Schema.Struct({
      mode: Schema.Literal("custom"),
      rules: Schema.Struct({
        worktreeKeepWhen: Schema.optionalKey(WorktreeKeepWhen),
        worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
        worktreeSettledAfterDays: Schema.optionalKey(SettledWorktreeRetentionDays),
        worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
        worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
        worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
        worktreeOnArchive: Schema.optionalKey(Schema.Boolean),
        worktreeSnapshotChanges: Schema.optionalKey(Schema.Boolean),
        worktreeKeepRecent: Schema.optionalKey(WorktreeKeepRecent),
      }),
    }),
  ]),
);

export const StorageCleanupSettingsPatch = Schema.Struct({
  worktreeKeepWhen: Schema.optionalKey(WorktreeKeepWhen),
  worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
  worktreeSettledAfterDays: Schema.optionalKey(SettledWorktreeRetentionDays),
  worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
  worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
  worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
  worktreeOnArchive: Schema.optionalKey(Schema.Boolean),
  worktreeSnapshotChanges: Schema.optionalKey(Schema.Boolean),
  worktreeKeepRecent: Schema.optionalKey(WorktreeKeepRecent),
  worktreeSnapshotDays: Schema.optionalKey(StorageRetentionDays),
  browserArtifactsAfterDays: Schema.optionalKey(StorageRetentionDays),
  logsAfterDays: Schema.optionalKey(StorageRetentionDays),
  historyBudgetBytes: Schema.optionalKey(HistoryBudgetBytes),
  historyArchiveAfterDays: Schema.optionalKey(StorageRetentionDays),
  historyArchiveDeleteAfterDays: Schema.optionalKey(StorageRetentionDays),
});
