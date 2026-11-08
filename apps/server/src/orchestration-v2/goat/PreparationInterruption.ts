import type { RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type * as ThreadManagement from "../ThreadManagementService.ts";

const WATCH_RETRY_MS = 5_000;

/**
 * Interrupts once the preparing run is interrupted or cancelled. A failed event read resubscribes
 * from the same cursor, which replays anything missed; it must not fail a healthy preparation.
 */
export const watchPreparationInterruption = Effect.fn("PreparationInterruption.watch")(
  function* (input: {
    readonly threads: ThreadManagement.ThreadManagementService["Service"];
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly afterSequence: number;
  }) {
    const { threadId, runId } = input;
    const ended = yield* input.threads
      .streamStoredEventsFrom({
        threadId,
        afterSequence: input.afterSequence,
        eventType: "run.updated",
      })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === runId &&
            (stored.event.payload.status === "interrupted" ||
              stored.event.payload.status === "cancelled"),
        ),
        Stream.runHead,
        Effect.tapError((cause) =>
          Effect.logWarning("Workspace preparation lost its cancellation watch; resubscribing", {
            threadId,
            runId,
            cause,
          }),
        ),
        Effect.retry({ schedule: Schedule.spaced(WATCH_RETRY_MS) }),
      );
    return yield* Option.isSome(ended) ? Effect.interrupt : Effect.never;
  },
);

/**
 * Once a person stops a preparing run, its remaining preparation commands are refused. That
 * refusal is the stop, so preparation undoes its workspace as it would for an interruption.
 */
export const preparationRunStopped = (
  threads: ThreadManagement.ThreadManagementService["Service"],
  threadId: ThreadId,
  runId: RunId | null,
) =>
  runId === null
    ? Effect.succeed(false)
    : threads.getThreadRecords(threadId, ["runs"]).pipe(
        Effect.map(({ runs }) => {
          const status = runs.find((run) => run.id === runId)?.status;
          return status === "interrupted" || status === "cancelled";
        }),
        Effect.orElseSucceed(() => false),
      );
