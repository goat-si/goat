import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2ThreadProjection,
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
    (session.driver === "opencode" &&
      session.providerSession.capabilities.turns.supportsNativeGoals === true)
  );
}
