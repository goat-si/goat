import type { OrchestrationV2RunAttempt, RunId } from "@goat/contracts";

type RunInputDelivery = NonNullable<OrchestrationV2RunAttempt["inputDelivery"]>;

export function indexRunInputDelivery(attempts: ReadonlyArray<OrchestrationV2RunAttempt>) {
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
  return evidence;
}
