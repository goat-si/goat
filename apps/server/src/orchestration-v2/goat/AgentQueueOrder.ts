import type { OrchestrationV2Run, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";

export const agentQueuePrecedesSend = Effect.fn("Orchestrator.agentQueuePrecedesSend")(function* (
  store: ProjectionStoreV2Shape,
  threadId: ThreadId,
  runs: ReadonlyArray<OrchestrationV2Run>,
) {
  const queued = runs.filter((run) => run.status === "queued" && run.queueHeld !== true);
  if (queued.length === 0) return false;
  const messages = yield* store.getMessagesById(
    threadId,
    queued.map((run) => run.userMessageId),
  );
  return [...messages.values()].some((message) => message.createdBy === "agent");
});
