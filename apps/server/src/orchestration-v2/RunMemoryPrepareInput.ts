import type { OrchestrationV2Run } from "@goat/contracts";

import { continuationOrigin } from "./ContinuationChain.ts";

export interface RunMemoryPrepareInput {
  readonly memoryGrantCeiling: import("@goat/contracts").MemoryTaskGrantCeiling | null;
}

export function runMemoryPrepareInput(input: {
  readonly run: OrchestrationV2Run;
  readonly message: Pick<
    import("@goat/contracts").OrchestrationV2ConversationMessage,
    "createdBy" | "creationSource" | "scheduledTaskId"
  >;
  readonly projection: Pick<
    import("@goat/contracts").OrchestrationV2ThreadProjection,
    "runs" | "messages"
  >;
}): RunMemoryPrepareInput {
  const origin = continuationOrigin(input);
  if (origin === undefined) return { memoryGrantCeiling: "none" };
  const { run, message } = origin;
  const ordinary =
    message.createdBy === "user" &&
    (message.creationSource === "web" || message.creationSource === "mobile") &&
    message.scheduledTaskId === undefined &&
    run.delegatedTaskId === undefined;
  return { memoryGrantCeiling: ordinary ? null : (run.memoryGrantCeiling ?? "none") };
}
