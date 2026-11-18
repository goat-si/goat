import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import { createOrchestrationV2TurnItemVisibility } from "@goat/shared/orchestrationV2Timeline";
import type * as SqlClient from "effect/sql/SqlClient";

export interface ForkHistoryPage {
  readonly before?: Pick<OrchestrationV2TurnItem, "ordinal" | "id"> | undefined;
  readonly throughRunOrdinal?: number;
  readonly includeImported: boolean;
  readonly visibleOnly?: boolean;
  readonly excludeItemId?: TurnItemId | undefined;
  readonly maxBytes: number;
  readonly limit: number;
}

export const FORK_HISTORY_TYPES = [
  "user_message",
  "assistant_message",
  "command_execution",
  "error",
  "run_interrupt_result",
  "file_change",
  "proposed_plan",
] satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

const historyTypes = new Set<OrchestrationV2TurnItem["type"]>(FORK_HISTORY_TYPES);

export const readForkHistoryPage = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  runIds: ReadonlyArray<RunId> | undefined,
  page: ForkHistoryPage,
) => sql<{ readonly payload_json: string }>`
  SELECT item.payload_json FROM orchestration_v2_projection_turn_items AS item
  LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
  WHERE item.thread_id = ${threadId}
    AND item.type IN ${sql.in(FORK_HISTORY_TYPES)}
    AND ${page.before === undefined ? sql`1` : sql`(item.ordinal, item.turn_item_id) < (${page.before.ordinal}, ${page.before.id})`}
    AND ${page.excludeItemId === undefined ? sql`1` : sql`item.turn_item_id <> ${page.excludeItemId}`}
    AND length(CAST(item.payload_json AS BLOB)) + 1 <= ${page.maxBytes}
    AND (
      (item.run_id IS NULL AND ${page.includeImported ? 1 : 0} = 1)
      OR (item.run_id IS NOT NULL
        AND ${runIds === undefined ? sql`1` : sql`item.run_id IN (SELECT value FROM json_each(${JSON.stringify(runIds)}))`}
        AND ${page.throughRunOrdinal === undefined ? sql`1` : sql`run.ordinal <= ${page.throughRunOrdinal}`})
    )
    AND ${
      page.visibleOnly !== true
        ? sql`1`
        : sql`
      COALESCE(run.status, '') <> 'rolled_back'
      AND NOT (
        item.type = 'user_message' AND
        COALESCE(json_extract(item.payload_json, '$.inputIntent'), '') = 'queued_turn' AND
        COALESCE(run.status, '') IN ('queued', 'cancelled')
      )
      AND NOT (
        item.type = 'run_interrupt_result'
        AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_run_attempts AS attempt
          WHERE attempt.thread_id = item.thread_id AND attempt.run_id = item.run_id
            AND attempt.root_node_id = item.node_id AND attempt.status = 'superseded'
        )
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items AS request
          WHERE request.thread_id = item.thread_id AND request.run_id = item.run_id
            AND request.type = 'run_interrupt_request'
        )
      )
    `
    }
  ORDER BY item.ordinal DESC, item.turn_item_id DESC LIMIT ${page.limit}
`;

export const forkHistoryItemBytes = (item: OrchestrationV2TurnItem) =>
  Buffer.byteLength(JSON.stringify(item)) + 1;

export function selectMemoryHistory(
  projection: OrchestrationV2ThreadProjection,
  runIds?: ReadonlyArray<RunId>,
  page?: ForkHistoryPage,
) {
  if (page === undefined)
    return projection.turnItems.filter(
      (item) =>
        historyTypes.has(item.type) &&
        (runIds === undefined || (item.runId !== null && runIds.includes(item.runId))),
    );
  const visible =
    page.visibleOnly === true
      ? createOrchestrationV2TurnItemVisibility({ ...projection, items: projection.turnItems })
      : () => true;
  return projection.turnItems
    .filter(
      (item) =>
        historyTypes.has(item.type) &&
        item.id !== page.excludeItemId &&
        visible(item) &&
        (item.runId === null
          ? page.includeImported
          : (runIds === undefined || runIds.includes(item.runId)) &&
            (page.throughRunOrdinal === undefined ||
              projection.runs.some(
                (run) =>
                  run.id === item.runId && run.ordinal <= (page.throughRunOrdinal ?? Infinity),
              ))) &&
        (page.before === undefined ||
          item.ordinal < page.before.ordinal ||
          (item.ordinal === page.before.ordinal && item.id < page.before.id)) &&
        forkHistoryItemBytes(item) <= page.maxBytes,
    )
    .toSorted(
      (left, right) =>
        right.ordinal - left.ordinal || (right.id === left.id ? 0 : right.id > left.id ? 1 : -1),
    )
    .slice(0, page.limit);
}
