import type { OrchestrationV2ThreadProjection, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export const hasNoNativeTurn = Effect.fn("CodexSurvivors.hasNoNativeTurn")(function* (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  threadId: ThreadId,
  run: OrchestrationV2ThreadProjection["runs"][number],
) {
  const ancestry: RunId[] = [run.id];
  let sourceId = run.restartContinuationOfRunId;
  while (sourceId !== undefined) {
    if (ancestry.includes(sourceId) || ancestry.length >= 32) return false;
    ancestry.push(sourceId);
    const records = yield* projections.getThreadRecords(threadId, ["runs"], { runIds: [sourceId] });
    const source = records.runs.find((item) => item.id === sourceId);
    if (!source) return false;
    sourceId = source.restartContinuationOfRunId;
  }
  const records = yield* projections.getThreadRecords(threadId, ["providerTurns"], {
    ancestryRunIds: ancestry,
  });
  return !records.providerTurns.some((turn) => turn.nativeTurnRef?.nativeId);
});
