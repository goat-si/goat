import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import {
  StaleCleanupPreviewError,
  WorktreeCleanupPreviewState,
} from "./WorktreeCleanupPreviewState.ts";

const DAY = 24 * 60 * 60 * 1000;
type Row = {
  preview_id: string;
  started_at: number;
  planned_count: number;
  seen_at: number | null;
  acknowledged_count: number | null;
  confirmed_at: number | null;
  activated_at: number | null;
};
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return WorktreeCleanupPreviewState.of({
    evaluate: Effect.fn("WorktreeCleanupPreviewState.evaluate")(function* ({
      nowMs,
      plannedCount,
      requiresConfirmation,
    }) {
      const id = crypto.randomUUID();
      yield* sql`INSERT OR IGNORE INTO worktree_cleanup_preview (preview_id, started_at, planned_count) VALUES (${id}, ${nowMs}, ${plannedCount})`;
      const rows = yield* sql<Row>`UPDATE worktree_cleanup_preview SET
        preview_id = CASE WHEN activated_at IS NULL AND (confirmed_at IS NOT NULL OR (${requiresConfirmation ? 0 : 1} = 1 AND seen_at IS NOT NULL AND ${nowMs} >= seen_at + ${DAY})) AND ${plannedCount} > acknowledged_count THEN ${id} ELSE preview_id END,
        started_at = CASE WHEN activated_at IS NULL AND (confirmed_at IS NOT NULL OR (${requiresConfirmation ? 0 : 1} = 1 AND seen_at IS NOT NULL AND ${nowMs} >= seen_at + ${DAY})) AND ${plannedCount} > acknowledged_count THEN ${nowMs} ELSE started_at END,
        seen_at = CASE WHEN activated_at IS NULL AND (confirmed_at IS NOT NULL OR (${requiresConfirmation ? 0 : 1} = 1 AND seen_at IS NOT NULL AND ${nowMs} >= seen_at + ${DAY})) AND ${plannedCount} > acknowledged_count THEN NULL ELSE seen_at END,
        confirmed_at = CASE WHEN activated_at IS NULL AND (confirmed_at IS NOT NULL OR (${requiresConfirmation ? 0 : 1} = 1 AND seen_at IS NOT NULL AND ${nowMs} >= seen_at + ${DAY})) AND ${plannedCount} > acknowledged_count THEN NULL ELSE confirmed_at END,
        acknowledged_count = CASE WHEN activated_at IS NULL AND (confirmed_at IS NOT NULL OR (${requiresConfirmation ? 0 : 1} = 1 AND seen_at IS NOT NULL AND ${nowMs} >= seen_at + ${DAY})) AND ${plannedCount} > acknowledged_count THEN NULL ELSE acknowledged_count END,
        activated_at = CASE WHEN activated_at IS NULL AND (confirmed_at IS NOT NULL OR (${requiresConfirmation ? 0 : 1} = 1 AND seen_at IS NOT NULL AND ${nowMs} >= seen_at + ${DAY})) AND ${plannedCount} <= acknowledged_count THEN ${nowMs} ELSE activated_at END,
        planned_count = ${plannedCount} WHERE singleton = 1 RETURNING *`;
      const row = rows[0];
      if (row === undefined) return yield* Effect.die("missing cleanup preview row");
      if (row.activated_at !== null) return { apply: true, preview: null };
      return {
        apply: false,
        preview: {
          id: row.preview_id,
          plannedCount: row.planned_count,
          startedAt: new Date(row.started_at).toISOString(),
          seenAt: row.seen_at === null ? null : new Date(row.seen_at).toISOString(),
          activatesAt:
            requiresConfirmation || row.seen_at === null
              ? null
              : new Date(row.seen_at + DAY).toISOString(),
          requiresConfirmation,
        },
      };
    }, Effect.orDie),
    respond: Effect.fn("WorktreeCleanupPreviewState.respond")(function* ({
      previewId,
      response,
      nowMs,
    }) {
      const rows = yield* sql<{ preview_id: string }>`UPDATE worktree_cleanup_preview SET
        seen_at = CASE WHEN ${response} = 'seen' THEN coalesce(seen_at, ${nowMs}) ELSE seen_at END,
        confirmed_at = CASE WHEN ${response} = 'confirm' THEN ${nowMs} ELSE confirmed_at END,
        acknowledged_count = CASE WHEN ${response} = 'confirm' OR seen_at IS NULL THEN planned_count ELSE acknowledged_count END
        WHERE preview_id = ${previewId} AND activated_at IS NULL RETURNING preview_id`.pipe(
        Effect.orDie,
      );
      if (rows.length === 0) return yield* new StaleCleanupPreviewError({ previewId });
    }),
  });
});
export const layer = Layer.effect(WorktreeCleanupPreviewState, make);
