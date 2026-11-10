import type { ThreadId } from "@goat/contracts";

/** A detach removes its thread before releasing, but that thread's records still need releasing. */
export const releasedThreadIds = (input: {
  readonly entry: { readonly attachedThreadIds: Iterable<ThreadId> };
  readonly detachedThreadId?: ThreadId;
}) => {
  const threadIds = new Set(input.entry.attachedThreadIds);
  if (input.detachedThreadId !== undefined) threadIds.add(input.detachedThreadId);
  return threadIds;
};

export const detachedThreadField = (detachedThreadId: ThreadId | undefined) =>
  detachedThreadId === undefined ? {} : { detachedThreadId };
