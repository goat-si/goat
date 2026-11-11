import {
  type DecisionHandoff,
  isHandoffPending,
  OrchestrationV2TurnItemJson,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeItem = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2TurnItemJson));

/**
 * Every approval handoff still waiting for a person, oldest first. Complete on purpose, like the
 * feed's pending requests: a thread holds at most three, and a capped list would hide some.
 */
export const openApprovalHandoffs = Effect.fn("DecisionInbox.openApprovalHandoffs")(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The type predicate keeps the shape of the partial handoff lookup index.
  const rows = yield* sql<{
    readonly payload_json: string;
    readonly title: string | null;
    readonly parent_thread_id: string | null;
    readonly parent_title: string | null;
  }>`SELECT i.payload_json, t.title, parent.thread_id AS parent_thread_id, parent.title AS parent_title
    FROM orchestration_v2_projection_turn_items i
    JOIN orchestration_v2_projection_threads t
      ON t.thread_id = i.thread_id AND t.deleted_at IS NULL AND t.archived_at IS NULL
    LEFT JOIN orchestration_v2_projection_threads parent
      ON parent.thread_id = json_extract(t.payload_json, '$.lineage.parentThreadId')
      AND parent.deleted_at IS NULL
    WHERE i.type IN ('human_handoff', 'secret_request') AND i.type = 'human_handoff'
      AND i.status = 'waiting'
      AND json_extract(i.payload_json, '$.handoff.kind') = 'approval'
    ORDER BY json_extract(i.payload_json, '$.handoff.createdAt'), i.turn_item_id`;
  const handoffs: DecisionHandoff[] = [];
  for (const row of rows) {
    const item = yield* decodeItem(row.payload_json);
    if (item.type !== "human_handoff" || !isHandoffPending(item.handoff.state)) continue;
    handoffs.push({
      threadTitle: row.title ?? "",
      ...(row.parent_thread_id === null
        ? {}
        : {
            parentThreadId: ThreadId.make(row.parent_thread_id),
            parentThreadTitle: row.parent_title ?? "",
          }),
      handoff: item.handoff,
    });
  }
  return handoffs;
});
