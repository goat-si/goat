import * as Deferred from "effect/Deferred";

interface QueuedTurnLike {
  readonly nativeStartReady?: Deferred.Deferred<void>;
  readonly subagent: unknown;
  readonly providerThread: { readonly nativeThreadRef: { readonly nativeId: string } | null };
}

/** Codex answers a queued turn without a start time and accepts turn/interrupt only once it starts. */
export const awaitingNativeStart = (context: QueuedTurnLike): boolean =>
  context.nativeStartReady !== undefined && !Deferred.isDoneUnsafe(context.nativeStartReady);

/**
 * The started root turns sharing a native thread with a stopped turn that is still queued. Codex
 * starts a queued turn only after the running one ends, so stopping it means stopping that turn.
 */
export const queueBlockers = <T extends QueuedTurnLike>(
  stopped: ReadonlyArray<T>,
  active: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  const threads = new Set(
    stopped.filter(awaitingNativeStart).flatMap((context) => {
      const nativeId = context.providerThread.nativeThreadRef?.nativeId;
      return nativeId === undefined ? [] : [nativeId];
    }),
  );
  return active.filter(
    (context) =>
      context.subagent === null &&
      !stopped.includes(context) &&
      !awaitingNativeStart(context) &&
      threads.has(context.providerThread.nativeThreadRef?.nativeId ?? ""),
  );
};
