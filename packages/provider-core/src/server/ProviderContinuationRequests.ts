import {
  type OrchestrationV2Notification,
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";

export interface ProviderContinuationRequest {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly driver: ProviderDriverKind;
  readonly detail: string | null;
  readonly notification?: OrchestrationV2Notification;
  readonly delegatedCompletion?: {
    readonly parentRunId: RunId;
    readonly generation: number;
    readonly messageId: MessageId;
  };
  /** adapter_buffered (default) ingests existing CLI output; message_text delivers app-owned wake text. */
  readonly delivery?: "adapter_buffered" | "message_text";
  readonly messageId?: MessageId;
  readonly dispatchIfCurrent?: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  readonly clearIfCurrent?: () => Effect.Effect<void>;
  /** Called when the run this request dispatched ends without starting, such as a cancelled queued run. */
  readonly onRunEndedWithoutStarting?: () => Effect.Effect<void>;
}

export interface ProviderContinuationOffer {
  readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void | "overflow">;
  readonly awaitSpace?: (threadId: ThreadId) => Effect.Effect<void>;
}

/** The default drops requests; share the live layer with the worker that drains them. */
export class ProviderContinuationRequests extends Context.Reference<
  ProviderContinuationOffer & {
    readonly awaitDelegatedRetry?: Effect.Effect<void>;
    readonly take: Effect.Effect<ProviderContinuationRequest>;
    readonly takeEligible?: (
      canTake: (threadId: ThreadId) => boolean,
      awaitCapacityChange: () => Effect.Effect<void>,
    ) => Effect.Effect<ProviderContinuationRequest>;
  }
>("@goat/provider-core/server/ProviderContinuationRequests", {
  defaultValue: () => ({ offer: () => Effect.void, take: Effect.never }),
}) {}

/** Providers keep ownership of a wake until it enters the bounded mailbox. */
export const offerWithBackpressure = Effect.fn(
  "ProviderContinuationRequests.offerWithBackpressure",
)(function* (requests: ProviderContinuationOffer, request: ProviderContinuationRequest) {
  while ((yield* requests.offer(request)) === "overflow") {
    if (requests.awaitSpace === undefined)
      return yield* Effect.die("Wake queue overflow requires a capacity signal");
    yield* requests.awaitSpace(request.threadId);
  }
});

const MAX_PENDING_PER_THREAD = 128;
const MAX_PENDING = 1_024;
const RESERVED_NEW_THREAD_SLOTS = 16;

export const layer = Layer.effect(
  ProviderContinuationRequests,
  Effect.sync(() => {
    type Entry = { readonly order: number; readonly request: ProviderContinuationRequest };
    const pending = new Map<ThreadId, Map<MessageId | ProviderContinuationRequest, Entry>>();
    let order = 0;
    let size = 0;
    let space = Deferred.makeUnsafe<void>();
    let delegatedOverflow = false;
    let delegatedRetry = Deferred.makeUnsafe<void>();
    const isFull = (threadId: ThreadId) => {
      const count = pending.get(threadId)?.size ?? 0;
      return (
        count >= MAX_PENDING_PER_THREAD ||
        size >= (count === 0 ? MAX_PENDING : MAX_PENDING - RESERVED_NEW_THREAD_SLOTS)
      );
    };
    const awaitSpace = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.suspend(() =>
        isFull(threadId)
          ? Deferred.await(space).pipe(Effect.andThen(awaitSpace(threadId)))
          : Effect.void,
      );
    let offered = Deferred.makeUnsafe<void>();
    // Keep saturated threads at their source while the consumer takes the oldest eligible wake.
    const takeEligible = (
      canTake: (threadId: ThreadId) => boolean,
      awaitCapacityChange: () => Effect.Effect<void>,
    ): Effect.Effect<ProviderContinuationRequest> =>
      Effect.suspend(() => {
        const changed = awaitCapacityChange();
        let oldest:
          | {
              readonly key: MessageId | ProviderContinuationRequest;
              readonly entry: Entry;
              readonly queue: Map<MessageId | ProviderContinuationRequest, Entry>;
            }
          | undefined;
        for (const [threadId, queue] of pending) {
          if (!canTake(threadId)) continue;
          const first = queue.entries().next().value;
          if (
            first !== undefined &&
            (oldest === undefined || first[1].order < oldest.entry.order)
          ) {
            oldest = { key: first[0], entry: first[1], queue };
          }
        }
        if (oldest === undefined) {
          return Effect.raceFirst(Deferred.await(offered), changed).pipe(
            Effect.andThen(takeEligible(canTake, awaitCapacityChange)),
          );
        }
        const { entry, key, queue } = oldest;
        queue.delete(key);
        size--;
        if (queue.size === 0) pending.delete(entry.request.threadId);
        const previous = space;
        space = Deferred.makeUnsafe<void>();
        Deferred.doneUnsafe(previous, Effect.void);
        if (delegatedOverflow) {
          delegatedOverflow = false;
          Deferred.doneUnsafe(delegatedRetry, Effect.void);
        }
        return Effect.succeed(entry.request);
      });

    return {
      offer: Effect.fn("ProviderContinuationRequests.offer")(function (
        request: ProviderContinuationRequest,
      ) {
        return Effect.suspend(() => {
          const key = request.delegatedCompletion?.messageId ?? request.messageId ?? request;
          const existingQueue = pending.get(request.threadId);
          const existing = existingQueue?.get(key);
          if (existingQueue !== undefined && existing !== undefined) {
            existingQueue.set(key, { order: existing.order, request });
            return Effect.void;
          }
          if (isFull(request.threadId)) {
            if (request.delegatedCompletion !== undefined) delegatedOverflow = true;
            return Effect.succeed("overflow" as const);
          }
          const queue = existingQueue ?? new Map();
          queue.set(key, { order: order++, request });
          pending.set(request.threadId, queue);
          size++;
          const previous = offered;
          offered = Deferred.makeUnsafe<void>();
          return Deferred.succeed(previous, undefined).pipe(Effect.asVoid);
        });
      }),
      take: takeEligible(
        () => true,
        () => Effect.never,
      ),
      takeEligible,
      awaitSpace,
      awaitDelegatedRetry: Effect.suspend(() =>
        Deferred.await(delegatedRetry).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              delegatedRetry = Deferred.makeUnsafe<void>();
            }),
          ),
        ),
      ),
    };
  }),
);
