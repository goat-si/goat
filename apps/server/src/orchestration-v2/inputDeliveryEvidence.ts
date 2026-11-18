import type { MessageId, OrchestrationV2ThreadProjection, RunId } from "@goat/contracts";

type RunInputDelivery = NonNullable<OrchestrationV2RunAttempt["inputDelivery"]>;

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
    const source = runsById.get(attempt.runId)?.manualContinuationOfRunId;
    const sourceMessageId =
      attempt.replayedInputMessageId ??
      (source === undefined || attempt.reason === "steering_restart"
        ? undefined
        : runsById.get(source)?.userMessageId);
    if (sourceMessageId !== undefined && replayed.get(sourceMessageId) !== "accepted")
      replayed.set(
        sourceMessageId,
        attempt.replayedInputMessageId !== undefined && attempt.inputDelivery === "accepted"
          ? "accepted"
          : "ambiguous",
      );
  }
  for (const run of runs) {
    const own = evidence.get(run.id);
    const delivery = replayed.get(run.userMessageId);
    if (own !== undefined && own.delivery !== "accepted" && delivery !== undefined)
      evidence.set(run.id, { ...own, delivery });
  }
  return evidence;
}
