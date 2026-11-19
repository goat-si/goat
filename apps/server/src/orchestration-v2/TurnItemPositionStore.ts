import { OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class TurnItemPositionStoreError extends Schema.TaggedError<TurnItemPositionStoreError>()(
  "TurnItemPositionStoreError",
  {
    threadId: ThreadId,
    turnItemId: TurnItemId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isTurnItemPositionStoreError = Schema.is(TurnItemPositionStoreError);

export function positionRequest(item: OrchestrationV2TurnItem) {
  const cursorTaskItem =
    item.runId === null &&
    item.providerThreadId === null &&
    item.providerTurnId === null &&
    item.nativeItemRef?.driver === "cursor" &&
    (item.threadId.startsWith("thread:subagent:") ||
      item.threadId.startsWith("thread:provider:cursor:native-thread:"));
  return {
    threadId: item.threadId,
    turnItemId: item.id,
    runId: item.runId,
    keepExisting: item.status === "pending",
    ...(cursorTaskItem ? { preferredOrdinal: item.ordinal } : {}),
  };
}

export interface TurnItemPositionStoreV2Shape {
  readonly allocate: (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
    readonly runId: RunId | null;
    readonly runOrdinal?: number;
    readonly preferredOrdinal?: number;
    // `run_start` takes the run's unused first slot, ahead of its items, and appends once it is taken.
    readonly placement?: "append" | "run_start";
    // Keep an existing position even when it lies outside the run's range.
    readonly keepExisting?: boolean;
  }) => Effect.Effect<number, TurnItemPositionStoreError>;
  readonly normalize: (
    item: OrchestrationV2TurnItem,
    runOrdinal?: number,
  ) => Effect.Effect<OrchestrationV2TurnItem, TurnItemPositionStoreError>;
}

export class TurnItemPositionStoreV2 extends Context.Service<
  TurnItemPositionStoreV2,
  TurnItemPositionStoreV2Shape
>()("goat/orchestration-v2/TurnItemPositionStore/TurnItemPositionStoreV2") {}

export const layer: Layer.Layer<TurnItemPositionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  TurnItemPositionStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const allocate: TurnItemPositionStoreV2Shape["allocate"] =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(
        function* ({
          threadId,
          turnItemId,
          runId,
          runOrdinal: suppliedRunOrdinal,
          preferredOrdinal,
          placement = "append",
          keepExisting = false,
        }) {
          const existing = yield* sql<{ readonly ordinal: number }>`
          SELECT ordinal
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
          LIMIT 1
        `;
          const current = existing[0]?.ordinal;
          if (current !== undefined && keepExisting) return current;
          const runRows =
            runId === null || suppliedRunOrdinal !== undefined
              ? []
              : yield* sql<{ readonly ordinal: number }>`
                SELECT ordinal
                FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId} AND run_id = ${runId}
                LIMIT 1
              `;
          const runOrdinal = suppliedRunOrdinal ?? runRows[0]?.ordinal ?? null;
          const lowerBound = runOrdinal === null ? 0 : runOrdinal * 1_000_000;
          const upperBound = runOrdinal === null ? 999_999 : lowerBound + 999_999;
          if (current !== undefined) {
            // A steer that missed its turn starts the next run; it moves into that run's range.
            if (runOrdinal === null || (current >= lowerBound && current <= upperBound)) {
              return current;
            }
            yield* sql`
            UPDATE orchestration_v2_turn_item_positions
            SET ordinal = (
              SELECT COALESCE(MAX(ordinal), ${lowerBound}) + 1
              FROM orchestration_v2_turn_item_positions
              WHERE thread_id = ${threadId}
                AND ordinal >= ${lowerBound}
                AND ordinal <= ${upperBound}
            )
            WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
          `;
          } else {
            const append = sql`COALESCE(MAX(ordinal), ${lowerBound}) + 1`;
            const position =
              preferredOrdinal !== undefined &&
              Number.isSafeInteger(preferredOrdinal) &&
              preferredOrdinal > lowerBound &&
              preferredOrdinal <= upperBound
                ? sql`CASE WHEN MAX(CASE WHEN ordinal = ${preferredOrdinal} THEN 1 ELSE 0 END) = 1
                      THEN ${append} ELSE ${preferredOrdinal} END`
                : placement === "run_start"
                  ? sql`CASE WHEN COALESCE(MIN(ordinal), ${upperBound}) > ${lowerBound} THEN ${lowerBound} ELSE MAX(ordinal) + 1 END`
                  : append;
            yield* sql`
            INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
            SELECT
              ${threadId},
              ${turnItemId},
              ${position}
            FROM orchestration_v2_turn_item_positions
            WHERE thread_id = ${threadId}
              AND ordinal >= ${lowerBound}
              AND ordinal <= ${upperBound}
            ON CONFLICT(thread_id, turn_item_id) DO NOTHING
          `;
          }
          const rows = yield* sql<{ readonly ordinal: number }>`
          SELECT ordinal
          FROM orchestration_v2_turn_item_positions
          WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
          LIMIT 1
        `;
          const ordinal = rows[0]?.ordinal;
          if (ordinal === undefined) {
            return yield* new TurnItemPositionStoreError({
              threadId,
              turnItemId,
              cause: "Position allocation returned no row.",
            });
          }
          return ordinal;
        },
        (effect, { threadId, turnItemId }) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isTurnItemPositionStoreError(cause)
                ? cause
                : new TurnItemPositionStoreError({ threadId, turnItemId, cause }),
            ),
          ),
      );

    return TurnItemPositionStoreV2.of({
      allocate,
      // Per-event normalization shares the enclosing orchestration span.
      normalize: Effect.fnUntraced(function* (item, runOrdinal) {
        return yield* allocate({
          ...positionRequest(item),
          ...(runOrdinal === undefined ? {} : { runOrdinal }),
        }).pipe(Effect.map((ordinal) => (item.ordinal === ordinal ? item : { ...item, ordinal })));
      }),
    });
  }),
);
