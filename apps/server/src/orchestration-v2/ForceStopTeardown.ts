import type {
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import type * as Orchestrator from "./Orchestrator.ts";
import type * as ProviderSessionManager from "./ProviderSessionManager.ts";
import type * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const RELEASE_WAIT = "10 seconds";
const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

// Queued work and runs that ended before starting, like a cancelled follow-up, never used the
// session, so they cannot supersede the stopped run.
const ownsSession = (run: OrchestrationV2Run) =>
  LIVE_RUN_STATUSES.has(run.status) || Boolean(run.startedAt);

/**
 * A cloud agent runs at its vendor. Releasing its session only closes GOAT's observer, which
 * would report the work stopped while it continues, so Force stop leaves it to the cloud Stop.
 */
export const runsInCloud = (
  records: Pick<OrchestrationV2ThreadProjection, "providerThreads">,
  threadId: ThreadId,
) =>
  records.providerThreads.some(
    (providerThread) =>
      providerThread.appThreadId === threadId && providerThread.cloudTask !== undefined,
  );

/**
 * Force stop's session teardown, bound to the run it was requested for. It holds the thread
 * lock, so no run is admitted while it decides and detaches, and it tears nothing down once a
 * run newer than the target exists: that run now owns the session.
 */
export const tearDownForceStoppedRun = Effect.fn("ForceStopTeardown.tearDown")(function* (
  deps: {
    readonly threadDispatch: ThreadCommandExecutor.ThreadCommandExecutor["Service"];
    readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
    readonly sessions: ProviderSessionManager.ProviderSessionManagerV2["Service"];
    readonly layerScope: Scope.Scope;
  },
  input: {
    readonly threadId: ThreadId;
    readonly target: OrchestrationV2Run | undefined;
    readonly detail: string;
  },
) {
  const { sessions } = deps;
  const { threadId } = input;
  return yield* deps.threadDispatch.withLock(
    threadId,
    Effect.gen(function* () {
      const records = yield* deps.orchestrator.getThreadRecords(threadId, [
        "runs",
        "providerThreads",
      ]);
      const target = input.target;
      const superseded =
        target !== undefined &&
        records.runs.some((run) => run.ordinal > target.ordinal && ownsSession(run));
      if (superseded) return { shared: true, releasing: false, sharedWith: [] };
      const own = records.providerThreads.filter((thread) => thread.appThreadId === threadId);
      const detach = (providerSessionId: ProviderSessionId) =>
        sessions
          .detach({ providerSessionId, threadId, detail: input.detail })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.force-stop-detach-failed", { threadId, cause }),
            ),
          );
      let shared = false;
      let releasing = false;
      const sharedWith = new Set<ThreadId>();
      for (const providerSessionId of new Set(
        own.flatMap((thread) => thread.providerSessionId ?? []),
      )) {
        if (!(yield* sessions.isLive(providerSessionId))) continue;
        const others = yield* sessions.otherWorkingThreads({ providerSessionId, threadId });
        for (const other of others) sharedWith.add(other);
        if (others.length > 0) {
          shared = true;
          yield* detach(providerSessionId);
          continue;
        }
        // Only the target run's own turns may be busy; any other busy turn keeps the session.
        const release = yield* sessions
          .releaseUnlessBusy({
            providerSessionId,
            ownProviderThreadIds: own.map((thread) => thread.id),
            runOrdinal: target?.ordinal ?? -1,
            reason: "manual_shutdown",
            detail: input.detail,
          })
          .pipe(Effect.forkIn(deps.layerScope));
        // Teardown waits on the provider's own exit paths; past this bound it keeps going.
        const released = yield* Fiber.join(release).pipe(Effect.timeoutOption(RELEASE_WAIT));
        if (Option.isNone(released)) releasing = true;
        else if (!released.value) {
          shared = true;
          yield* detach(providerSessionId);
        }
      }
      return { shared, releasing, sharedWith: [...sharedWith] };
    }),
  );
});
