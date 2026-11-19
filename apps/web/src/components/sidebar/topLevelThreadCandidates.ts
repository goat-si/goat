import { isSideChatThread } from "@goat/contracts";
import { foldLaunchedThreads } from "@goat/client-runtime/state/launch-fold";
import type { Thread } from "../../types";

export function topLevelThreadCandidates<T extends Thread>(
  threads: readonly T[],
  now = new Date().toISOString(),
): readonly T[] {
  const visible = threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      !isSideChatThread(thread) &&
      thread.lineage.relationshipToParent !== "subagent",
  );
  return foldLaunchedThreads({ visible, all: threads, now }).roots;
}
