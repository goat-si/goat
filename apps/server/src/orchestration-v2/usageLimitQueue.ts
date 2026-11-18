import type { ModelSelection, OrchestrationV2ThreadProjection, RunId } from "@goat/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
  usageLimitBlockedRun,
} from "@goat/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

export function usageLimitHoldsQueue(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems" | "providerSessions">,
  providerInstanceId: ModelSelection["instanceId"],
  now?: DateTime.Utc,
): boolean {
  let latestSession: OrchestrationV2ThreadProjection["providerSessions"][number] | undefined;
  for (const session of projection.providerSessions) {
    if (
      session.providerInstanceId === providerInstanceId &&
      (latestSession === undefined ||
        DateTime.isGreaterThan(session.updatedAt, latestSession.updatedAt))
    ) {
      latestSession = session;
    }
  }
  const limited = usageLimitBlockedRun(
    projection.runs.filter((run) => run.providerInstanceId === providerInstanceId),
    projection.turnItems,
    latestSession?.lastError ?? null,
  );
  if (limited === null) return false;
  if (latestExecutedRun(projection.runs)?.id === limited.id) return true;
  if (now === undefined) return false;
  const resetAt = latestRootProviderFailure(limited, projection.turnItems)?.resetAt;
  return resetAt != null && Date.parse(resetAt) > DateTime.toEpochMillis(now);
}

type ProjectionRun = OrchestrationV2ThreadProjection["runs"][number];

/** User work queued behind a usage limit cannot start until the reset or the user acts. */
export const usageLimitHoldsQueuedRuns = <E, R>(
  runs: ReadonlyArray<ProjectionRun>,
  queued: ReadonlyArray<Pick<ProjectionRun, "providerInstanceId">>,
  loadErrors: (filter: {
    readonly turnItemTypes: ReadonlyArray<"error">;
    readonly turnItemRunIds: ReadonlyArray<RunId>;
  }) => Effect.Effect<
    Pick<OrchestrationV2ThreadProjection, "turnItems" | "providerSessions">,
    E,
    R
  >,
): Effect.Effect<boolean, E, R> => {
  const latest = latestExecutedRun(runs);
  if (queued.length === 0 || latest?.status !== "failed") return Effect.succeed(false);
  // Only the error items of the run a usage limit stopped decide it.
  return Effect.map(
    loadErrors({ turnItemTypes: ["error"], turnItemRunIds: [latest.id] }),
    (records) =>
      queued.every((run) => usageLimitHoldsQueue({ ...records, runs }, run.providerInstanceId)),
  );
};
