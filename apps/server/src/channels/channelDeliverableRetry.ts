import {
  type ChannelChildWork,
  type ChannelDeliverable,
  requiredDeliverableRequestKey,
  isChannelChildWorkTerminal,
} from "@goat/contracts";

export function retryRequiredDeliverable(
  items: ReadonlyArray<ChannelDeliverable> | undefined,
  request: { readonly id: string; readonly attempt: number },
  child: ChannelChildWork | undefined,
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
  if (child.state === "completed" && item.review?.decision !== "rejected") return undefined;
  return items.map((entry) =>
    entry === item ? { id: item.id, criterion: item.criterion, attempt: item.attempt + 1 } : entry,
  );
}
