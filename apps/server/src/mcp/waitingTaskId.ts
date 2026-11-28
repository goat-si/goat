import type { OrchestrationV2ThreadProjection } from "@goat/contracts";

type Projection = OrchestrationV2ThreadProjection;

export const waitingTaskId = (
  run: Projection["runs"][number] | null,
  thread: Projection["thread"],
) =>
  run?.delegatedTaskId ??
  (thread.forkedFrom?.type === "node" ? thread.forkedFrom.nodeId : undefined);
