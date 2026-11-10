import {
  ThreadId,
  type ServerSettings,
  type StorageCleanupReportEntry,
  type WorktreeCleanupPreview,
  type WorktreeCleanupRules,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { WorktreeCleanupPreviewState } from "./worktreeSnapshots/WorktreeCleanupPreviewState.ts";
import { WorktreeSnapshotStore } from "./worktreeSnapshots/WorktreeSnapshotStore.ts";

interface WorktreePass {
  readonly waiting: boolean;
  readonly kept: ReadonlyArray<string>;
}

/** Whether a removal checked under `before` must stop because a setting it relied on changed. */
export const removalSettingsChanged = (
  before: ServerSettings,
  after: ServerSettings,
  rules: WorktreeCleanupRules,
  current: WorktreeCleanupRules,
) =>
  after.autoResumeLimitedThreads !== before.autoResumeLimitedThreads ||
  after.snoozeLimitedThreads !== before.snoozeLimitedThreads ||
  after.storageCleanup.worktreeCleanupPreview !== before.storageCleanup.worktreeCleanupPreview ||
  (Object.keys(rules) as Array<keyof WorktreeCleanupRules>).some(
    (key) => current[key] !== rules[key],
  );

/**
 * Runs one sweep's worktree work: snapshot housekeeping first, then removal. With the opt-in
 * preview on, a dry pass only marks what cleanup would remove until a person saw or confirmed it.
 */
export const makeWorktreeCleanupRun = Effect.fn("StorageCleanup.makeWorktreeCleanupRun")(function* (
  requiresConfirmation: Effect.Effect<boolean>,
) {
  const previewState = yield* WorktreeCleanupPreviewState;
  const store = yield* WorktreeSnapshotStore;
  const sql = yield* SqlClient.SqlClient;
  // Activation never reverts, so later sweeps skip the dry pass.
  let activated = false;
  const housekeeping = Effect.fn("StorageCleanup.snapshotHousekeeping")(
    function* (nowMs: number, snapshotDays: number | null) {
      const deleted = yield* sql<{ threadId: string }>`
          SELECT thread_id AS "threadId" FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NOT NULL
        `.pipe(NodeSqliteClient.readOnly);
      yield* store.purgeDeletedThreads(
        nowMs,
        deleted.map((row) => ThreadId.make(row.threadId)),
      );
      if (snapshotDays !== null) yield* store.expire(nowMs, snapshotDays);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("worktree snapshot housekeeping failed", { cause }),
    ),
  );
  const run = Effect.fn("StorageCleanup.runWorktreeCleanup")(function* <E, R>(input: {
    readonly nowMs: number;
    readonly snapshotDays: number | null;
    readonly preview: boolean;
    readonly entries: StorageCleanupReportEntry[];
    readonly clean: (
      dryRun: boolean,
      entries: StorageCleanupReportEntry[],
    ) => Effect.Effect<WorktreePass, E, R>;
  }) {
    yield* housekeeping(input.nowMs, input.snapshotDays);
    const none: WorktreeCleanupPreview | null = null;
    if (activated || !input.preview)
      return { ...(yield* input.clean(false, input.entries)), preview: none };
    const dryEntries: StorageCleanupReportEntry[] = [];
    const dry = yield* input.clean(true, dryEntries);
    const plannedCount = dryEntries.filter((entry) => entry.planned === true).length;
    // Nothing to remove needs no preview; the first sweep with candidates starts one.
    if (plannedCount === 0) {
      input.entries.push(...dryEntries);
      return { ...dry, preview: none };
    }
    const gate = yield* previewState.evaluate({
      nowMs: input.nowMs,
      plannedCount,
      requiresConfirmation: yield* requiresConfirmation,
    });
    if (!gate.apply) {
      input.entries.push(...dryEntries);
      return { ...dry, preview: gate.preview };
    }
    activated = true;
    return { ...(yield* input.clean(false, input.entries)), preview: none };
  });
  const forgetPreview = Effect.sync(() => {
    activated = false;
  }).pipe(Effect.andThen(previewState.reset));
  // Turning the preview off forgets it, so turning it on again shows a new one. null is startup.
  const forgetIfTurnedOff = (before: ServerSettings | null, after: ServerSettings) =>
    !after.storageCleanup.worktreeCleanupPreview &&
    (before === null || before.storageCleanup.worktreeCleanupPreview)
      ? forgetPreview
      : Effect.void;
  return Object.assign(run, { forgetPreview, forgetIfTurnedOff });
});
