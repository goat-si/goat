import type { NodeId, ScopedThreadRef, ThreadId, TurnItemId } from "@goat/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "./threads";

/**
 * The subagents a response reported on, read once when Reply is clicked so a timeline row does
 * not subscribe to the thread for it. A result arrives as a message from the subagent's thread or
 * as a completion notice just before the response. Only subagents with a thread in this
 * environment count: the server keeps no other, and GOAT's remote subagents have none here.
 */
export function readResponseSubagents(
  ref: ScopedThreadRef,
  itemId: TurnItemId,
): ReadonlyArray<{ readonly threadId: ThreadId; readonly title: string }> {
  const projection = Option.getOrNull(
    appAtomRegistry.get(environmentThreadDetails.stateAtom(ref)).data,
  );
  if (!projection) return [];
  const items = projection.visibleTurnItems;
  const isInput = (index: number) => {
    const type = items[index]?.item.type;
    return type === "user_message" || type === "notification";
  };
  let index = items.findIndex((projected) => projected.sourceItemId === itemId) - 1;
  while (index >= 0 && !isInput(index)) index -= 1;

  const threadByTask = new Map<NodeId, ThreadId>();
  const titles = new Map<ThreadId, string | null>();
  for (const subagent of projection.subagents) {
    if (subagent.childThreadId === null || subagent.remote !== undefined) continue;
    threadByTask.set(subagent.id, subagent.childThreadId);
    titles.set(subagent.childThreadId, subagent.title);
  }
  const found = new Set<ThreadId>();
  const add = (threadId: ThreadId | undefined) => {
    if (threadId !== undefined && titles.has(threadId)) found.add(threadId);
  };
  for (; index >= 0 && isInput(index); index -= 1) {
    const item = items[index]?.item;
    if (item?.type === "notification") {
      const { source } = item;
      if (source.kind === "subagent" || source.kind === "delegated_task") add(source.childThreadId);
      if (source.kind === "delegated_task") {
        for (const taskId of source.taskIds) add(threadByTask.get(taskId));
      }
    } else if (item?.type === "user_message") {
      // A sender counts only as this thread's subagent: a child's first message comes from its parent.
      add(item.senderThreadId);
    }
  }
  return [...found].map((threadId) => ({
    threadId,
    title: titles.get(threadId)?.trim() || "Agent",
  }));
}
