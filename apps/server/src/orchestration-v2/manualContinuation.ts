import { MAX_CONTINUATION_CHAIN } from "./ContinuationChain.ts";
import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@goat/contracts";

export function unsentManualContinuationSource(
  run: OrchestrationV2Run | undefined,
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
) {
  let sourceId = run?.manualContinuationOfRunId;
  if (sourceId === undefined) return undefined;
  const runs = new Map(projection.runs.map((source) => [source.id, source]));
  const acceptedAttempts = new Set(projection.providerTurns.map((turn) => turn.runAttemptId));
  const acceptedRuns = new Set(
    projection.attempts
      .filter((attempt) => acceptedAttempts.has(attempt.id))
      .map((attempt) => attempt.runId),
  );
  const visited = new Set<OrchestrationV2Run["id"]>();
  while (sourceId !== undefined && !visited.has(sourceId)) {
    visited.add(sourceId);
    const source = runs.get(sourceId);
    if (
      source === undefined ||
      acceptedRuns.has(sourceId) ||
      (source.activeAttemptId !== null && acceptedAttempts.has(source.activeAttemptId))
    )
      return undefined;
    if (source.manualContinuationOfRunId === undefined) return source;
    sourceId = source.manualContinuationOfRunId;
  }
  return undefined;
}

export function turnStartMessageIds(
  run: OrchestrationV2Run | undefined,
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
) {
  const ids = [];
  const unsentSource = unsentManualContinuationSource(run, projection);
  if (unsentSource !== undefined) ids.push(unsentSource.userMessageId);
  for (let depth = 0; run !== undefined && depth <= MAX_CONTINUATION_CHAIN; depth++) {
    ids.push(run.userMessageId);
    const sourceId = run.restartContinuationOfRunId ?? run.usageLimitContinuationOfRunId;
    if (sourceId === undefined) break;
    run = projection.runs.find((candidate) => candidate.id === sourceId);
  }
  return ids;
}
