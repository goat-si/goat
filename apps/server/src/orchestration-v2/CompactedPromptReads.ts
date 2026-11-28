import {
  OrchestrationV2TurnItemJson,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import { runRanAfter } from "@goat/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ProjectionRecordFilter } from "./ProjectionStore.ts";
import { DEFERRED_WORK_ITEM_TYPES } from "./threadHistoryPaging.ts";
import {
  anchorsModelSwitch,
  isModelSwitchCandidate,
  isShownUserMessageItem,
} from "./modelSwitch.ts";

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));
export const compactedPromptReads = Effect.fn("ProjectionStore.compactedPromptReads")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  runs: ReadonlyArray<OrchestrationV2Run>,
  recentRunIds: ReadonlyArray<RunId>,
) {
  const errors = yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_v2_projection_turn_items
    INDEXED BY orchestration_v2_projection_turn_items_failed_error_idx
    WHERE thread_id = ${threadId} AND type = 'error' AND status = 'failed'`.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.payload_json))),
  );
  const readPrompts = (ids: ReadonlyArray<string>) =>
    sql<{ payload_json: string }>`SELECT payload_json FROM orchestration_v2_projection_turn_items
    INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
    WHERE thread_id = ${threadId} AND type = 'user_message' AND run_id IN (SELECT value FROM json_each(${encodeIds(ids)}))`.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.payload_json))),
    );
  const read = new Set<string>(recentRunIds);
  for (const run of runs) if (run.freshContext === true) read.add(run.id);
  const prompts = yield* readPrompts([...read]);
  const shown = new Set<string>();
  const show = (items: ReadonlyArray<OrchestrationV2TurnItem>) => {
    for (const item of items)
      if (item.type === "user_message" && isShownUserMessageItem(item)) shown.add(item.messageId);
  };
  show(prompts);
  const newestFirst = runs
    .filter(isModelSwitchCandidate)
    .toSorted((left, right) => (runRanAfter(left, right) ? -1 : 1));
  for (let start = 0, size = 1; start < newestFirst.length; start += size, size *= 2) {
    const batch = newestFirst.slice(start, start + size);
    const unread = batch.filter((run) => !read.has(run.id));
    if (unread.length > 0) {
      for (const run of unread) read.add(run.id);
      const more = yield* readPrompts(unread.map((run) => run.id));
      show(more);
      prompts.push(...more);
    }
    if (batch.some((run) => anchorsModelSwitch(run, shown))) break;
  }
  return [...errors, ...prompts].toSorted(
    (left, right) =>
      left.ordinal - right.ordinal || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
});

export const runIdsSinceLastCompaction = Effect.fn("ProjectionStore.runIdsSinceLastCompaction")(
  function* (
    sql: SqlClient.SqlClient,
    threadId: ThreadId,
    keep: NonNullable<ProjectionRecordFilter["sinceLastCompaction"]>,
  ) {
    // A held queue can run out of ordinal order, so a run that ended after the compaction's
    // run was requested is recent too. Every run row is read anyway, so this scan reads no
    // extra pages.
    const recent = yield* sql<{ readonly run_id: RunId }>`
          WITH compaction AS (
            SELECT run.ordinal, run.requested_at
            FROM orchestration_v2_projection_turn_items AS item
              INDEXED BY orchestration_v2_projection_turn_items_conversation_idx
            INNER JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
            WHERE item.thread_id = ${threadId}
              AND item.type = 'compaction' AND item.status = 'completed'
              AND item.type NOT IN ${sql.literal(`(${DEFERRED_WORK_ITEM_TYPES.map((type) => `'${type}'`).join(", ")})`)}
              AND run.status <> 'rolled_back'
            ORDER BY item.ordinal DESC
            LIMIT 1
          )
          SELECT run.run_id
          FROM compaction
          INNER JOIN orchestration_v2_projection_runs AS run ON run.thread_id = ${threadId}
          WHERE run.ordinal >= compaction.ordinal
            OR run.completed_at IS NULL
            OR run.completed_at >= compaction.requested_at
            OR run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
          UNION
          SELECT message.run_id
          FROM compaction
          INNER JOIN orchestration_v2_projection_messages AS message
            ON message.message_id = ${keep.keepMessageId}
          WHERE message.thread_id = ${threadId} AND message.run_id IS NOT NULL
        `;
    // The compaction's own run is always recent, so no rows means no compaction.
    return recent.length === 0 ? null : [...recent.map((row) => row.run_id), ...keep.keepRunIds];
  },
);
