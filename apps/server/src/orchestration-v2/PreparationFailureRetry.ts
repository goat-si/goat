import { CommandId, type RunId, type ThreadId } from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";
import { type PreparationLog, withPreparationLog } from "./preparationLog.ts";
import { failureDetail, preparationFailureClass } from "./goat/ThreadLaunchError.ts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export const persistPreparationFailure = Effect.fn("ThreadLaunchService.persistPreparationFailure")(
  function* <A, E>(input: {
    persist: Effect.Effect<A, E>;
    isPreparing: Effect.Effect<boolean>;
    retry: boolean;
    log: (cause: Cause.Cause<E>) => Effect.Effect<void>;
  }) {
    yield* input.persist.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* input.log(cause);
          if (!input.retry || Cause.hasInterruptsOnly(cause) || !(yield* input.isPreparing)) return;
          yield* input.persist.pipe(
            Effect.catchCauseIf(
              (retryCause) => !Cause.hasInterruptsOnly(retryCause),
              (retryCause) =>
                input.isPreparing.pipe(
                  Effect.flatMap((preparing) =>
                    preparing ? Effect.fail(retryCause) : Effect.void,
                  ),
                ),
            ),
            Effect.retry(
              Schedule.exponential("1 second").pipe(
                Schedule.modifyDelay(({ duration }) =>
                  Effect.succeed(Duration.min(duration, Duration.seconds(30))),
                ),
              ),
            ),
            Effect.ignoreCause,
            Effect.interruptible,
          );
        }),
      ),
      Effect.asVoid,
    );
  },
);

export const makeFailPreparedRun = (threads: ThreadManagementServiceShape) => {
  return (
    input: { readonly commandId: CommandId },
    threadId: ThreadId,
    runId: RunId | null,
    cause: unknown,
    log: PreparationLog = [],
    retryPersistence = true,
  ) =>
    runId === null
      ? Effect.logWarning("Thread workspace preparation failed", {
          commandId: input.commandId,
          threadId,
          cause,
        })
      : persistPreparationFailure({
          persist: threads.dispatch({
            type: "prepared-run.fail",
            commandId: CommandId.make(`${input.commandId}:fail`),
            threadId,
            runId,
            failure: withPreparationLog(
              makeProviderFailure({
                cause,
                message: failureDetail(cause),
                ...preparationFailureClass(cause),
              }),
              log,
            ),
          }),
          isPreparing: threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] }).pipe(
            Effect.map((current) =>
              current.runs.some((run) => run.id === runId && run.status === "preparing"),
            ),
            Effect.catchCause(() => Effect.succeed(true)),
          ),
          retry: retryPersistence,
          log: (persistCause) =>
            Effect.logWarning("Failed to persist thread workspace preparation failure", {
              commandId: input.commandId,
              threadId,
              cause,
              persistCause,
            }),
        });
};
