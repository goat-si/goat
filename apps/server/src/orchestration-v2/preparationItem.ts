import type {
  OrchestrationV2Command,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@goat/contracts";

export const WORKSPACE_PREPARATION_INPUT = "Preparing workspace";

export function withoutPreparationResult(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>,
) {
  const { output: _output, exitCode: _exitCode, outputIndicatesFailure: _failure, ...rest } = item;
  return rest;
}

export const preparedRunState = (
  command: Extract<
    OrchestrationV2Command,
    {
      readonly type:
        | "prepared-run.release"
        | "prepared-run.progress"
        | "prepared-run.fail"
        | "prepared-run.retry";
    }
  >,
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "attempts" | "nodes" | "providerThreads" | "turnItems"
  >,
) => {
  const run = projection.runs.find((candidate) => candidate.id === command.runId);
  const attempt = projection.attempts.find((candidate) => candidate.id === run?.activeAttemptId);
  const rootNode = projection.nodes.find((candidate) => candidate.id === run?.rootNodeId);
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run?.providerThreadId,
  );
  const preparationItem = projection.turnItems.find(
    (
      candidate,
    ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }> =>
      candidate.runId === command.runId &&
      candidate.type === "command_execution" &&
      candidate.input === WORKSPACE_PREPARATION_INPUT,
  );
  if (
    run?.status !== (command.type === "prepared-run.retry" ? "failed" : "preparing") ||
    attempt === undefined ||
    rootNode === undefined ||
    providerThread === undefined ||
    preparationItem === undefined
  ) {
    return null;
  }
  return { run, attempt, rootNode, providerThread, preparationItem } as const;
};
