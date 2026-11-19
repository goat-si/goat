import type { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as ProjectionStore from "./ProjectionStore.ts";

export const isAppOwnedDelegatedThread = Effect.fn("DelegatedThreadProvenance.isAppOwned")(
  function* (store: ProjectionStore.ProjectionStoreV2["Service"], threadId: ThreadId) {
    const { thread } = yield* store.getThreadRecords(threadId, []);
    const parent = thread.lineage.parentThreadId;
    if (
      thread.lineage.relationshipToParent !== "subagent" ||
      parent === null ||
      thread.forkedFrom?.type !== "node"
    )
      return false;
    const taskId = thread.forkedFrom.nodeId;
    const { subagents } = yield* store.getThreadRecords(parent, ["subagents"], {
      subagentIds: [taskId],
    });
    return subagents.some(
      (task) =>
        task.id === taskId && task.origin === "app_owned" && task.childThreadId === threadId,
    );
  },
);
