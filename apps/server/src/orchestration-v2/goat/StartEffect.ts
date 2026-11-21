import type { NodeId, RunAttemptId, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ProviderTurnStartServiceV2Shape } from "../ProviderTurnStartTypes.ts";
import type { ProviderTurnStartError } from "../ProviderTurnStartTypes.ts";
import { WorkspaceLeaseBusyError } from "./WorkspaceLeaseBusyError.ts";

const isWorkspaceLeaseBusy = Schema.is(WorkspaceLeaseBusyError);

export function makeStartEffect(provider: ProviderTurnStartServiceV2Shape) {
  return (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly effectId: string;
    readonly willRetry: boolean;
  }) =>
    provider.start(input).pipe(
      Effect.catchIf(
        (
          error,
        ): error is ProviderTurnStartError & {
          readonly attemptId: RunAttemptId;
          readonly rootNodeId: NodeId;
        } =>
          !input.willRetry &&
          !isWorkspaceLeaseBusy(error.cause) &&
          error.attemptId !== undefined &&
          error.rootNodeId !== undefined,
        (error) => {
          return provider
            .failStartingRun({
              threadId: input.threadId,
              runId: input.runId,
              attemptId: error.attemptId,
              rootNodeId: error.rootNodeId,
              ...(error.message === "" ? {} : { failureMessage: error.message }),
            })
            .pipe(
              Effect.tapError(() =>
                Effect.logError("Failed to settle exhausted start", {
                  effectId: input.effectId,
                  runId: input.runId,
                  attemptId: error.attemptId,
                  rootNodeId: error.rootNodeId,
                }),
              ),
              Effect.andThen(Effect.fail(error)),
            );
        },
      ),
    );
}

export function makeRestartCleanup(provider: ProviderTurnStartServiceV2Shape) {
  return <E>(
    input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly effectId: string;
      readonly willRetry: boolean;
    },
    cleanup: Effect.Effect<void, E>,
  ) =>
    Effect.gen(function* () {
      const identity = yield* provider.getStartingRunIdentity(input);
      yield* cleanup.pipe(
        Effect.catchIf(
          () => !input.willRetry && identity !== undefined,
          (error) => {
            if (identity === undefined) return Effect.fail(error);
            return provider
              .failStartingRun({ threadId: input.threadId, runId: input.runId, ...identity })
              .pipe(
                Effect.tapError(() =>
                  Effect.logError("Failed to settle exhausted restart", {
                    effectId: input.effectId,
                    runId: input.runId,
                    ...identity,
                  }),
                ),
                Effect.andThen(Effect.fail(error)),
              );
          },
        ),
      );
    });
}
