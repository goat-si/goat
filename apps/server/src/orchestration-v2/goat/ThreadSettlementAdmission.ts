import type { OrchestrationV2Run, OrchestrationV2RuntimeRequest, RunId } from "@goat/contracts";

export function settlementAdmission(input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly requests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly automaticQueuedRuns: ReadonlyArray<OrchestrationV2Run>;
  readonly expectedLatestRunId?: RunId | undefined;
}) {
  const latest = input.runs.reduce<OrchestrationV2Run | undefined>(
    (current, run) => (current === undefined || run.ordinal > current.ordinal ? run : current),
    undefined,
  );
  const pendingRequests = input.requests.filter((request) => request.status === "pending");
  const blockingRequest = pendingRequests.some(
    (request) => request.kind !== "user_input" || request.responseCapability.type !== "message",
  );
  const running = input.runs.some((run) =>
    ["preparing", "starting", "running", "waiting"].includes(run.status),
  );
  const queued = input.runs.some(
    (run) => run.status === "queued" && !input.automaticQueuedRuns.includes(run),
  );
  return {
    stale: input.expectedLatestRunId !== undefined && latest?.id !== input.expectedLatestRunId,
    pendingRequests,
    blocker: blockingRequest
      ? "is waiting on an approval or question. Answer it before settling."
      : running
        ? "is still running. Stop it before settling."
        : queued
          ? "has a queued message. Send it or remove it from the queue before settling."
          : null,
  };
}
