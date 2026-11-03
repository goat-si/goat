import type { OrchestrationV2ProviderTurn, RunId, ThreadId } from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as ProjectionStore from "../ProjectionStore.ts";

const MAX_CONTINUATION_ANCESTRY = 32;

/**
 * When a restart continuation adopts a Codex turn that kept running, the earlier runs' records of
 * that native turn end as cancelled. The native turn itself is not interrupted.
 */
export const handedOffSurvivorTurns = Effect.fn("CodexSurvivorHandoff.handedOffTurns")(function* (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  input: {
    readonly threadId: ThreadId;
    readonly runId: RunId | undefined;
    readonly providerTurn: OrchestrationV2ProviderTurn;
    readonly at: DateTime.Utc;
  },
) {
  const nativeId = input.providerTurn.nativeTurnRef?.nativeId;
  if (
    input.providerTurn.status !== "running" ||
    input.providerTurn.survivingRestart === undefined ||
    !nativeId ||
    input.runId === undefined
  )
    return [];
  const ancestry: RunId[] = [];
  let runId: RunId | undefined = input.runId;
  while (runId !== undefined && ancestry.length < MAX_CONTINUATION_ANCESTRY) {
    const records: ProjectionStore.ProjectionRecords<"runs"> = yield* projections.getThreadRecords(
      input.threadId,
      ["runs"],
      { runIds: [runId] },
    );
    runId = records.runs[0]?.restartContinuationOfRunId;
    if (runId === undefined || runId === input.runId || ancestry.includes(runId)) break;
    ancestry.push(runId);
  }
  if (ancestry.length === 0) return [];
  const { providerTurns, attempts } = yield* projections.getThreadRecords(
    input.threadId,
    ["providerTurns", "attempts"],
    { ancestryRunIds: ancestry },
  );
  return providerTurns.flatMap(({ survivingRestart: _marker, ...turn }) => {
    const runId = attempts.find((attempt) => attempt.id === turn.runAttemptId)?.runId;
    return runId !== undefined &&
      turn.id !== input.providerTurn.id &&
      turn.nativeTurnRef?.nativeId === nativeId &&
      (turn.status === "pending" || turn.status === "running")
      ? [{ runId, turn: { ...turn, status: "cancelled" as const, completedAt: input.at } }]
      : [];
  });
});
