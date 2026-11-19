import {
  OrchestrationV2ForceStopThreadError,
  type OrchestrationV2ForceStopThreadInput,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ProviderSessionId,
  type ThreadId,
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
const runsInCloud = (
  records: Pick<OrchestrationV2ThreadProjection, "providerThreads">,
  threadId: ThreadId,
) =>
  records.providerThreads.some(
    (providerThread) =>
      providerThread.appThreadId === threadId && providerThread.cloudTask !== undefined,
  );

const ownsForceStopProcess = Effect.fn("ForceStopTeardown.ownsProcess")(function* (
  sessions: ProviderSessionManager.ProviderSessionManagerV2["Service"],
  thread: OrchestrationV2ProviderThread,
) {
  if (thread.driver !== "opencode") return true;
  if (thread.providerSessionId == null) return false;
  const runtime = yield* sessions.get(thread.providerSessionId);
  return Option.getOrUndefined(runtime)?.providerSession.capabilities.sessions.ownsProcess === true;
});

export const checkForceStopTarget = Effect.fn("ForceStopTeardown.checkTarget")(function* (
  sessions: ProviderSessionManager.ProviderSessionManagerV2["Service"],
  input: OrchestrationV2ForceStopThreadInput,
  records: Pick<OrchestrationV2ThreadProjection, "thread" | "providerThreads">,
  target: OrchestrationV2Run | undefined,
) {
  if (input.runId !== undefined && input.runId !== target?.id) {
    return yield* new OrchestrationV2ForceStopThreadError({
      threadId: input.threadId,
      reason: "superseded",
    });
  }
  if (runsInCloud(records, input.threadId)) {
    return yield* new OrchestrationV2ForceStopThreadError({
      threadId: input.threadId,
      reason: "cloud",
    });
  }
  const providerThreadId = target?.providerThreadId ?? records.thread.activeProviderThreadId;
  const providerThread = records.providerThreads.find((thread) => thread.id === providerThreadId);
  if (providerThread !== undefined && !(yield* ownsForceStopProcess(sessions, providerThread))) {
    return yield* new OrchestrationV2ForceStopThreadError({
      threadId: input.threadId,
      cause: "GOAT could not verify ownership of the OpenCode server process for this run.",
    });
  }
});

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
      const checkedSessions = new Set<ProviderSessionId>();
      for (const thread of own) {
        const { providerSessionId } = thread;
        if (providerSessionId == null || checkedSessions.has(providerSessionId)) continue;
        checkedSessions.add(providerSessionId);
        if (!(yield* sessions.isLive(providerSessionId))) continue;
        if (!(yield* ownsForceStopProcess(sessions, thread))) continue;
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
