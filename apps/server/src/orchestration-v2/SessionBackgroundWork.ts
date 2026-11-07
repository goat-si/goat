import type { OrchestrationV2ThreadProjection, ProviderSessionId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ProviderSessionManagerV2Shape } from "./ProviderSessionManager.ts";

export function makeSessionHasBackgroundWork(providerSessions: ProviderSessionManagerV2Shape) {
  return Effect.fn("Orchestrator.sessionHasBackgroundWork")(function* (
    detaching: OrchestrationV2ThreadProjection["providerSessions"][number],
    providerThreads: OrchestrationV2ThreadProjection["providerThreads"],
  ) {
    const session = yield* providerSessions
      .get(detaching.id)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(session)) return false;
    const runtime = session.value;
    const probes =
      !detaching.capabilities.sessions.supportsMultipleProviderThreadsPerSession &&
      runtime.hasPendingBackgroundWork !== undefined
        ? [runtime.hasPendingBackgroundWork]
        : providerThreads.flatMap((providerThread) =>
            providerThread.providerSessionId === detaching.id &&
            runtime.hasPendingBackgroundWorkForThread !== undefined
              ? [runtime.hasPendingBackgroundWorkForThread(providerThread)]
              : [],
          );
    for (const probe of probes) {
      // A failed probe cannot confirm that the work ended.
      if (yield* probe.pipe(Effect.catchCause(() => Effect.succeed(true)))) return true;
    }
    return false;
  });
}

export const partitionSwitchSessions = Effect.fn("Orchestrator.partitionSwitchSessions")(function* (
  projection: OrchestrationV2ThreadProjection,
  releaseIds: ReadonlyArray<ProviderSessionId>,
  probe: ReturnType<typeof makeSessionHasBackgroundWork>,
) {
  const releasable = projection.providerSessions.filter(
    (session) =>
      releaseIds.includes(session.id) && session.status !== "stopped" && session.status !== "error",
  );
  const busySessionIds = new Set<ProviderSessionId>();
  for (const session of releasable) {
    if (yield* probe(session, projection.providerThreads)) busySessionIds.add(session.id);
  }
  return {
    busySessionIds,
    sessionsToDetach: releasable.filter((session) => !busySessionIds.has(session.id)),
  };
});
