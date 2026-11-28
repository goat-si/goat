import type {
  MessageId,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@goat/contracts";

/** Maximum automatic continuation ancestry resolved before requiring a new user turn. */
export const MAX_CONTINUATION_CHAIN = 3;

type RunInputDelivery = NonNullable<
  OrchestrationV2ThreadProjection["attempts"][number]["inputDelivery"]
>;

export function indexRunInputDelivery({
  attempts,
  runs,
}: Pick<OrchestrationV2ThreadProjection, "attempts" | "runs">) {
  const replacements = new Map<RunId, number>();
  for (const attempt of attempts) {
    if (attempt.reason === "steering_restart")
      replacements.set(
        attempt.runId,
        Math.max(replacements.get(attempt.runId) ?? 0, attempt.attemptOrdinal),
      );
  }

  const evidence = new Map<
    RunId,
    {
      readonly delivery: RunInputDelivery;
      readonly replaced: boolean;
    }
  >();
  for (const attempt of attempts) {
    const replacement = replacements.get(attempt.runId) ?? 0;
    if (attempt.attemptOrdinal < replacement) continue;
    const latest = attempt.inputDelivery ?? "ambiguous";
    const previous = evidence.get(attempt.runId)?.delivery;
    const delivery =
      latest === "accepted" || previous === "accepted"
        ? "accepted"
        : previous === "ambiguous"
          ? "ambiguous"
          : latest;
    evidence.set(attempt.runId, { delivery, replaced: replacement !== 0 });
  }
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const replayed = new Map<MessageId, Exclude<RunInputDelivery, "unsent">>();
  for (const attempt of attempts) {
    if (attempt.inputDelivery === "unsent" || attempt.status === "pending") continue;
    const sourceMessageId = attempt.replayedInputMessageId;
    if (sourceMessageId !== undefined) {
      if (replayed.get(sourceMessageId) !== "accepted")
        replayed.set(
          sourceMessageId,
          attempt.inputDelivery === "accepted" ? "accepted" : "ambiguous",
        );
      continue;
    }
    if (attempt.reason === "steering_restart") continue;
    let sourceId = runsById.get(attempt.runId)?.manualContinuationOfRunId;
    // Older replays could skip unsent Resume turns and send an ancestor's input.
    for (let depth = 0; sourceId !== undefined && depth <= MAX_CONTINUATION_CHAIN; depth++) {
      const source = runsById.get(sourceId);
      if (source === undefined) break;
      if (!replayed.has(source.userMessageId)) replayed.set(source.userMessageId, "ambiguous");
      sourceId = source.manualContinuationOfRunId;
    }
  }
  for (const run of runs) {
    const own = evidence.get(run.id);
    const delivery = replayed.get(run.userMessageId);
    if (own !== undefined && own.delivery !== "accepted" && delivery !== undefined)
      evidence.set(run.id, { ...own, delivery });
  }
  return evidence;
}

type Delivery =
  | { readonly type: "native" | "ambiguous" }
  | { readonly type: "replay"; readonly source: OrchestrationV2Run };

type Continuation = Pick<OrchestrationV2Run, "manualContinuationOfRunId">;
type History = Pick<OrchestrationV2ThreadProjection, "runs" | "attempts">;

export function manualContinuationDelivery(
  run: Continuation | undefined,
  projection: History,
): Delivery {
  let sourceId = run?.manualContinuationOfRunId;
  if (sourceId === undefined) return { type: "native" };
  const runs = new Map(projection.runs.map((source) => [source.id, source]));
  const evidence = indexRunInputDelivery(projection);
  const visited = new Set<OrchestrationV2Run["id"]>();
  while (
    sourceId !== undefined &&
    !visited.has(sourceId) &&
    visited.size <= MAX_CONTINUATION_CHAIN
  ) {
    visited.add(sourceId);
    const source = runs.get(sourceId);
    const input = evidence.get(sourceId);
    if (source === undefined || input === undefined) break;
    if (input.delivery === "accepted") return { type: "native" };
    if (input.delivery !== "unsent") break;
    if (
      !input.replaced &&
      (source.restartContinuationOfRunId !== undefined ||
        source.usageLimitContinuationOfRunId !== undefined)
    )
      break;
    if (input.replaced || source.manualContinuationOfRunId === undefined)
      return { type: "replay", source };
    sourceId = source.manualContinuationOfRunId;
  }
  return { type: "ambiguous" };
}

export function unsentManualContinuationSource(run: Continuation | undefined, projection: History) {
  const delivery = manualContinuationDelivery(run, projection);
  return delivery.type === "replay" ? delivery.source : undefined;
}

export function turnStartMessageIds(run: OrchestrationV2Run | undefined, projection: History) {
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
