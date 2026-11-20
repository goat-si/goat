import {
  latestProviderTurnForAttempt,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

export const sourceHasActiveRun = (runs: ReadonlyArray<OrchestrationV2Run>) =>
  runs.some(
    (run) =>
      run.status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting",
  );

export const ensureSafeNativeFork = (
  source: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns" | "attempts">,
  run: OrchestrationV2Run,
  session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  sourceThread: OrchestrationV2ProviderThread,
) => {
  const attempt = source.attempts.find((candidate) => candidate.id === run.activeAttemptId);
  const turn =
    latestProviderTurnForAttempt(source.providerTurns, attempt?.id) ??
    source.providerTurns.find((candidate) => candidate.id === attempt?.providerTurnId);
  return (run.status === "completed" || run.status === "waiting") &&
    (!sourceHasActiveRun(source.runs) ||
      (session.providerSession.capabilities.threads.canForkWhileSourceRunning === true &&
        run.status === "completed" &&
        turn?.status === "completed" &&
        turn.providerThreadId === sourceThread.id &&
        typeof turn.nativeTurnRef?.nativeId === "string" &&
        !turn.nativeTurnRef.nativeId.startsWith("turn:")))
    ? Effect.void
    : Effect.fail(
        new ProviderAdapter.ProviderAdapterForkThreadError({
          driver: session.driver,
          providerThreadId: sourceThread.id,
          cause:
            "Native fork requires a completed boundary and a capable adapter while the source is active.",
        }),
      );
};
