import {
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Only MCP lifecycle deletion opts into this policy; client deletion keeps its semantics. */
export class McpThreadDeletionPolicy extends Context.Reference<
  { readonly callerThreadId?: ThreadId } | undefined
>("goat/orchestration-v2/McpThreadDeletionPolicy", { defaultValue: () => undefined }) {}

export const deletionRefusal = Effect.fn("McpThreadDeletionPolicy.check")(function* (
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "subagents">,
) {
  const policy = yield* McpThreadDeletionPolicy;
  if (policy === undefined) return;
  if (projection.thread.id === policy.callerThreadId)
    return "An agent cannot delete its own thread.";
  if (isProviderNativeSubagentThread(projection.thread))
    return "Provider-native subagent threads are read-only.";
  if (
    projection.runs.some(
      (run) =>
        !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(run.status),
    )
  )
    return "The thread has a nonterminal run, including queued work. Stop or cancel it before deletion.";
  if (
    projection.subagents.some(
      (task) => !["completed", "failed", "cancelled", "interrupted"].includes(task.status),
    )
  )
    return "The thread has an active background subagent. Stop it before deletion.";
});
