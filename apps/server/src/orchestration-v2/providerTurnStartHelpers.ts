import {
  isCompactionCommandMessage,
  parseGoalCommand,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
/** A registered cloud task whose first run has not started: that run attaches, never submits. */
export const isRegisteredAttach = (thread: OrchestrationV2ProviderThread | undefined) =>
  thread?.cloudTask?.attach === "registered" &&
  thread.firstRunOrdinal === null &&
  thread.nativeThreadRef !== null &&
  (thread.cloudTask.status === "running" || thread.cloudTask.status === "submitting");

export function nativeForkTurns(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
) {
  const rolledBackRuns = new Set(
    projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
  );
  const rolledBackAttempts = new Set(
    projection.attempts
      .filter((attempt) => rolledBackRuns.has(attempt.runId))
      .map((attempt) => attempt.id),
  );
  return projection.providerTurns.filter(
    (turn) => turn.runAttemptId === null || !rolledBackAttempts.has(turn.runAttemptId),
  );
}

export function hasNativeGoals(
  session: Pick<
    import("@goat/provider-core/server/ProviderAdapter").ProviderAdapterV2SessionRuntime,
    "driver" | "providerSession"
  >,
) {
  return (
    session.driver === "codex" ||
    session.driver === "claudeAgent" ||
    session.providerSession.capabilities.turns.supportsNativeGoals === true
  );
}

/** Ready history handoffs a run starts with. */
export function readyHandoffsForRun(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "contextTransfers" | "contextHandoffs" | "runs" | "messages" | "providerThreads"
  >,
  run: Pick<OrchestrationV2Run, "id" | "providerThreadId">,
) {
  // Older versions also stored subagent replies as history handoffs. Their
  // queued completion messages carry the results without a history budget.
  const subagentResultTransfers = new Set(
    projection.contextTransfers
      .filter((transfer) => transfer.type === "subagent_result")
      .map((transfer) => transfer.id),
  );
  const handoffs = projection.contextHandoffs.filter(
    (handoff) =>
      (handoff.transferId == null || !subagentResultTransfers.has(handoff.transferId)) &&
      handoff.status === "ready" &&
      (handoff.targetRunId === run.id ||
        (handoff.toProviderThreadId === run.providerThreadId &&
          projection.runs.some(
            (source) =>
              source.id === handoff.targetRunId &&
              (((source.status === "failed" ||
                source.status === "interrupted" ||
                source.status === "cancelled") &&
                !(
                  (handoff.delivery?.status === "injected" ||
                    handoff.delivery?.status === "inline") &&
                  handoff.fromProviderThreadIds.length > 0 &&
                  handoff.fromProviderThreadIds.every((id) =>
                    projection.providerThreads.some((candidate) => candidate.id === id),
                  )
                )) ||
                (source.status === "completed" &&
                  handoff.delivery === undefined &&
                  // Compaction and /goal turns defer history to the next turn.
                  projection.messages.some(
                    (message) =>
                      message.id === source.userMessageId &&
                      (isCompactionCommandMessage(message) || parseGoalCommand(message) !== null),
                  ))),
          ))),
  );
  return handoffs;
}
