import {
  type ChannelChildWork,
  type ChannelDeliverable,
  type ChannelDeliverableView,
  requiredDeliverableRequestKey,
  isChannelChildWorkTerminal,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** Losing or dismissing remote tracking does not stop the worker on its host. */
export const confirmRequiredChildStopped = Effect.fn("channels.confirmRequiredChildStopped")(
  function* (sql: SqlClient.SqlClient, child: ChannelChildWork) {
    if (!isChannelChildWorkTerminal(child.state)) return false;
    if (child.surface !== "delegate_remote" || child.state === "released") return true;
    const destination = child.destination;
    if (!destination?.correlationId || !destination.host) return false;
    const rows = yield* sql`SELECT 1 FROM remote_dispatches
    WHERE correlation_id = ${destination.correlationId} AND origin_thread_id = ${child.callerThreadId}
      AND host = ${destination.host} AND kind = 'task' AND end_reason IS NULL
      AND state IN ('settled','cancelled') AND remote_thread_id IS NOT NULL
      AND (${destination.threadId ?? null} IS NULL OR remote_thread_id = ${destination.threadId ?? null})
      AND launched_run_id IS NOT NULL AND known_run_id = launched_run_id
      AND known_run_status IN ('completed','failed','cancelled','interrupted','rolled_back')`;
    return rows.length > 0;
  },
);

export function retryRequiredDeliverable(
  items: ReadonlyArray<ChannelDeliverable> | undefined,
  request: { readonly id: string; readonly attempt: number },
  child: ChannelChildWork | undefined,
  observed?: Pick<ChannelDeliverableView, "state" | "childWorkId">,
): ReadonlyArray<ChannelDeliverable> | undefined {
  const item = items?.find(({ id }) => id === request.id);
  if (
    !items ||
    !item ||
    !child ||
    item.attempt !== request.attempt ||
    !Number.isSafeInteger(item.attempt + 1) ||
    child.requestKey !== requiredDeliverableRequestKey(item.id, item.attempt) ||
    !isChannelChildWorkTerminal(child.state) ||
    (item.review !== undefined && item.review.childWorkId !== child.childWorkId) ||
    item.review?.decision === "accepted"
  )
    return undefined;
  if (
    child.state === "completed" &&
    item.review?.decision !== "rejected" &&
    !(observed?.state === "failed" && observed.childWorkId === child.childWorkId)
  )
    return undefined;
  return items.map((entry) =>
    entry === item ? { id: item.id, criterion: item.criterion, attempt: item.attempt + 1 } : entry,
  );
}
