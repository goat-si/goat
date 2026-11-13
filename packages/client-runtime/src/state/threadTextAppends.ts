import {
  OrchestrationV2GetThreadProjectionError,
  type OrchestrationV2ResolvedThreadStreamItem,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId,
} from "@goat/contracts";
import { makeThreadTextAppendDecoder } from "@goat/shared/threadTextAppend";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/** The cause of the failure a mismatched append raises; a resync is not an error to show. */
const THREAD_TEXT_RESYNC = new Error("Live thread text went out of step.");
const isProjectionError = Schema.is(OrchestrationV2GetThreadProjectionError);

const isThreadTextResync = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length > 0 &&
  cause.reasons.every(
    (reason) =>
      Cause.isFailReason(reason) &&
      isProjectionError(reason.error) &&
      reason.error.cause === THREAD_TEXT_RESYNC,
  );

/** The stream error a thread shows for an expected failure, or null for a text resync. */
export const threadStreamFailureMessage = (cause: Cause.Cause<unknown>): string | null => {
  if (isThreadTextResync(cause)) return null;
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
};

/**
 * Wrap exactly one subscription. A mismatched append fails it as an expected error, so the
 * subscription retries and resumes from its last applied sequence with whole entities.
 */
export const resolveThreadTextAppends = <E, R>(
  threadId: ThreadId,
  stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>,
  onMismatch?: () => void,
): Stream.Stream<
  OrchestrationV2ResolvedThreadStreamItem,
  E | OrchestrationV2GetThreadProjectionError,
  R
> =>
  Stream.suspend(() => {
    const decode = makeThreadTextAppendDecoder();
    return Stream.mapEffect(stream, (item) => {
      const resolved = decode(item);
      return resolved === null
        ? Effect.sync(() => onMismatch?.()).pipe(
            Effect.andThen(
              Effect.fail(
                new OrchestrationV2GetThreadProjectionError({
                  threadId,
                  message: "Live thread text went out of step; resynchronizing.",
                  cause: THREAD_TEXT_RESYNC,
                }),
              ),
            ),
          )
        : Effect.succeed(resolved);
    });
  });
