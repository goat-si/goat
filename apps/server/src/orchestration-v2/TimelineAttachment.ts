import type * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";
import type { OrchestrationV2ThreadProjection } from "@goat/contracts";
import type { ProjectionTimelinePageOptions } from "./ProjectionStore.ts";

const key = (threadId: string, itemId: string) => `${threadId.length}:${threadId}${itemId}`;

export const timelineAttachmentOwners = Effect.fn("ProjectionStore.timelineAttachmentOwners")(
  function* (
    sql: SqlClient.SqlClient,
    sourceThreadIds: ReadonlyArray<string>,
    attachmentId: string,
  ) {
    const rows = yield* sql<{ thread_id: string; turn_item_id: string }>`
      SELECT item.thread_id, item.turn_item_id
      FROM orchestration_v2_projection_turn_items AS item,
        json_each(item.payload_json, '$.attachments') AS attachment
      WHERE item.thread_id IN ${sql.in([...new Set(sourceThreadIds)])}
        AND item.type = 'user_message'
        AND json_extract(attachment.value, '$.id') = ${attachmentId}`;
    return new Set(rows.map((row) => key(row.thread_id, row.turn_item_id)));
  },
);

export function matchingTimelineRows<
  T extends {
    sourceThreadId: string;
    sourceItemId: string;
    item: { type: string };
  },
>(visible: ReadonlyArray<T>, options: ProjectionTimelinePageOptions, owners?: Set<string>) {
  return visible
    .map((row, position) => ({ ...row, position }))
    .filter(
      (row) =>
        (options.itemId === undefined
          ? row.position > (options.afterPosition ?? -1) &&
            (options.view === "activity" ||
              ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type))
          : row.sourceItemId === options.itemId) &&
        (owners?.has(key(row.sourceThreadId, row.sourceItemId)) ?? true),
    );
}

export function memoryTimelinePage(
  projection: OrchestrationV2ThreadProjection,
  options: ProjectionTimelinePageOptions,
) {
  const matching = projection.visibleTurnItems.filter(
    (row) =>
      (options.attachmentId === undefined ||
        (row.item.type === "user_message" &&
          row.item.attachments.some((attachment) => attachment.id === options.attachmentId))) &&
      (options.itemId === undefined
        ? row.position > (options.afterPosition ?? -1) &&
          (options.view === "activity" ||
            ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type))
        : row.sourceItemId === options.itemId),
  );
  const start = options.tail === true ? Math.max(0, matching.length - options.limit) : 0;
  return {
    items: matching.slice(start, start + options.limit),
    totalItems: projection.visibleTurnItems.length,
    hasMore: start + options.limit < matching.length,
  };
}
