import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { isAuthorizationFailure, subscriptionRetryDelay } from "../rpc/client.ts";

import { threadStreamFailureMessage } from "./threadTextAppends.ts";

const THREAD_SUBSCRIPTION_RETRY_DELAY: Duration.Input = "250 millis";
const SYNC_ERROR = "Could not synchronize the thread.";

/**
 * How a mounted thread subscription recovers on its own: a stream defect backs off and
 * resubscribes, and a 404 (the thread may not exist yet) asks HTTP again while mounted.
 * Each wait doubles from 250 ms to the 30 s cap; applied items reset the defect backoff.
 */
export const makeThreadSubscriptionRecovery = Effect.fnUntraced(function* (input: {
  readonly isCold: () => boolean;
  readonly initialNeedsFreshSnapshot?: boolean;
  readonly setStreamError: (message: string | null) => Effect.Effect<void>;
  readonly logAttributes: Record<string, unknown>;
}) {
  const resubscribes = yield* Queue.unbounded<void>();
  let httpMisses = 0;
  let defectRetries = 0;
  let triedColdSocket = false;
  let openingOverSocket = false;
  const failedColdOpen = () => openingOverSocket && input.isCold();
  // The cursor moved before the batch that failed to apply, so resuming from it would skip it.
  // Also seeded when opening a cached projection that still has active subagents.
  let needsFreshSnapshot = input.initialNeedsFreshSnapshot === true;
  const resubscribe = Queue.offer(resubscribes, undefined);
  const backOffAfterDefect = Effect.suspend(() =>
    input
      .setStreamError(SYNC_ERROR)
      .pipe(
        Effect.andThen(
          Effect.sleep(subscriptionRetryDelay(THREAD_SUBSCRIPTION_RETRY_DELAY, defectRetries++)),
        ),
      ),
  );
  return {
    openColdOverSocket: (supported: boolean) => {
      openingOverSocket = supported && !triedColdSocket;
      triedColdSocket ||= openingOverSocket;
      return openingOverSocket;
    },
    onExpectedFailure: (cause: Cause.Cause<unknown>) =>
      !isAuthorizationFailure(cause) && failedColdOpen()
        ? Effect.void
        : input.setStreamError(threadStreamFailureMessage(cause)),
    retryExpectedFailureAfter: THREAD_SUBSCRIPTION_RETRY_DELAY,
    resubscriptions: Stream.fromQueue(resubscribes),
    /** A delete event parks the subscription; a miss while mounted keeps asking. */
    parksDeleted: () => httpMisses === 0,
    found: Effect.sync(() => {
      httpMisses = 0;
    }),
    missed: Effect.suspend(() =>
      Effect.sleep(subscriptionRetryDelay(THREAD_SUBSCRIPTION_RETRY_DELAY, httpMisses++)),
    ).pipe(Effect.andThen(resubscribe)),
    applied: Effect.sync(() => {
      defectRetries = 0;
    }),
    onDefect: (cause: Cause.Cause<unknown>) =>
      Effect.suspend(() => {
        if (failedColdOpen()) {
          openingOverSocket = false;
          return resubscribe;
        }
        return Cause.hasDies(cause)
          ? backOffAfterDefect.pipe(Effect.andThen(resubscribe))
          : input.setStreamError(SYNC_ERROR);
      }),
    needsFreshSnapshot: Effect.sync(() => needsFreshSnapshot),
    snapshotApplied: Effect.sync(() => {
      needsFreshSnapshot = false;
    }),
    /** A defect while applying items ends the stream; follow again for a fresh snapshot. */
    restartAfterDefect: <E, R>(
      follow: Effect.Effect<void, E, R>,
    ): Effect.Effect<void, never, R> => {
      const run: Effect.Effect<void, never, R> = follow.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Thread subscription failed; resubscribing.", {
                cause: Cause.pretty(cause),
                ...input.logAttributes,
              }).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    needsFreshSnapshot = true;
                  }),
                ),
                Effect.andThen(backOffAfterDefect),
                Effect.andThen(Effect.suspend(() => run)),
              ),
        ),
      );
      return run;
    },
  };
});
