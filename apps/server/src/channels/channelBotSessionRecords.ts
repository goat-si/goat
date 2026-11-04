import type { ThreadId } from "@goat/contracts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export const readRecords = (
  threads: ThreadManagement.ThreadManagementService["Service"],
  threadId: ThreadId,
) =>
  threads.getThreadRecords(threadId, [
    "runs",
    "messages",
    "providerTurns",
    "runtimeRequests",
    "subagents",
  ]);

export const rejected = (failure: unknown) => {
  const tag = (failure as { readonly _tag?: string } | undefined)?._tag;
  return (
    tag === "OrchestratorCommandRejectedError" ||
    tag === "OrchestratorCommandPreviouslyRejectedError" ||
    tag === "ThreadManagementNoSteerableRunError"
  );
};
