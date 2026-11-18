import type {
  OrchestrationV2TurnItem,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type * as ProjectionStore from "./ProjectionStore.ts";

// Providers can announce a retry and never resume. Longer than any adapter's own stall handling.
const PROVIDER_RETRY_STALL_TIMEOUT = Duration.minutes(15);
type ProviderErrorItem = Extract<OrchestrationV2TurnItem, { readonly type: "error" }>;
type ProviderRetryItem = ProviderErrorItem & {
  readonly providerTurnId: ProviderTurnId;
  readonly providerThreadId: ProviderThreadId;
  readonly retry: NonNullable<ProviderErrorItem["retry"]>;
};

/** Fails a provider turn whose announced retry stays silent for a whole stall window. */
export const makeRetryStallWatch = (input: {
  readonly providerSessionId: ProviderSessionId;
  /** Whether the session that owns this watch is still the live one. */
  readonly isCurrent: Effect.Effect<boolean>;
  readonly projectionStore: ProjectionStore.ProjectionStoreV2Shape;
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
}) => {
  const runningRetries = new Map<ProviderTurnId, ProviderRetryItem>();
  const stalledRetries = new Map<ProviderTurnId, ProviderRetryItem>();
  const stallTimers = new Map<ProviderTurnId, Fiber.Fiber<void>>();
  // Claude and Pi keep the retry row running while a recovered reply streams, so any
  // event on the retry's thread counts as the provider being alive.
  const activeSinceCheck = new Set<ProviderTurnId>();
  const noteThreadActivity = (event: ProviderAdapter.ProviderAdapterV2Event) => {
    if (runningRetries.size === 0) return;
    const threadId =
      event.type === "turn_item.updated"
        ? event.turnItem.threadId
        : event.type === "message.updated"
          ? event.message.threadId
          : event.type === "node.updated"
            ? event.node.threadId
            : event.type === "plan.updated"
              ? event.plan.threadId
              : undefined;
    if (threadId === undefined) return;
    for (const item of runningRetries.values()) {
      if (item.threadId === threadId) activeSinceCheck.add(item.providerTurnId);
    }
  };
  // Stops the stalled turn; its interrupted terminal is then reported as the retry's failure.
  const stopStalledRetry = Effect.fn("ProviderSessionManager.stopStalledRetry")(
    function* (item: ProviderRetryItem) {
      if (runningRetries.get(item.providerTurnId) !== item) return;
      // The terminal this stop causes must not interrupt the stop itself.
      stallTimers.delete(item.providerTurnId);
      if (!(yield* input.isCurrent)) return;
      const { providerThread } = yield* input.projectionStore.getProviderControlContext(
        item.threadId,
        { providerThreadId: item.providerThreadId, providerTurnId: item.providerTurnId },
      );
      if (providerThread === undefined || runningRetries.get(item.providerTurnId) !== item) return;
      stalledRetries.set(item.providerTurnId, item);
      yield* input.runtime
        .interruptTurn({ providerThread, providerTurnId: item.providerTurnId })
        .pipe(
          // A slow stop can still end the turn later, so that terminal keeps the retry failure.
          Effect.catchTags({
            ProviderAdapterInterruptTimeoutError: (cause) =>
              Effect.logWarning("orchestration-v2.provider-retry-stall-stop-timed-out", {
                providerSessionId: input.providerSessionId,
                cause,
              }),
          }),
        );
    },
    (effect, item) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => stalledRetries.delete(item.providerTurnId)).pipe(
            Effect.andThen(
              Effect.logWarning("orchestration-v2.provider-retry-stall-stop-failed", {
                providerSessionId: input.providerSessionId,
                cause,
              }),
            ),
          ),
        ),
      ),
  );
  const stopStallTimer = (providerTurnId: ProviderTurnId) => {
    const fiber = stallTimers.get(providerTurnId);
    stallTimers.delete(providerTurnId);
    activeSinceCheck.delete(providerTurnId);
    return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
  };
  const track = (
    event: ProviderAdapter.ProviderAdapterV2Event,
  ): {
    readonly event: ProviderAdapter.ProviderAdapterV2Event;
    readonly armed?: ProviderRetryItem;
    readonly settled?: ProviderTurnId;
  } => {
    noteThreadActivity(event);
    if (event.type === "turn_item.updated") {
      const item = event.turnItem;
      if (
        item.type !== "error" ||
        item.retry === undefined ||
        item.providerTurnId === null ||
        item.providerThreadId === null
      )
        return { event };
      const retryItem = {
        ...item,
        providerTurnId: item.providerTurnId,
        providerThreadId: item.providerThreadId,
        retry: item.retry,
      };
      if (item.status === "running") {
        runningRetries.set(retryItem.providerTurnId, retryItem);
        return { event, armed: retryItem };
      }
      // A stall marker is set only once the stop is sent, so only the terminal clears it.
      runningRetries.delete(retryItem.providerTurnId);
      return { event, settled: retryItem.providerTurnId };
    }
    if (event.type === "provider_turn.updated") {
      if (event.providerTurn.status === "running") return { event };
      runningRetries.delete(event.providerTurn.id);
      const settled = event.providerTurn.id;
      return stalledRetries.has(settled) &&
        (event.providerTurn.status === "interrupted" || event.providerTurn.status === "cancelled")
        ? {
            event: { ...event, providerTurn: { ...event.providerTurn, status: "failed" } },
            settled,
          }
        : { event, settled };
    }
    if (event.type !== "turn.terminal") return { event };
    runningRetries.delete(event.providerTurnId);
    const stalled = stalledRetries.get(event.providerTurnId);
    stalledRetries.delete(event.providerTurnId);
    const settled = event.providerTurnId;
    if (stalled === undefined || (event.status !== "interrupted" && event.status !== "cancelled"))
      return { event, settled };
    return {
      settled,
      event: {
        type: "turn.terminal",
        driver: event.driver,
        providerThreadId: event.providerThreadId,
        providerTurnId: event.providerTurnId,
        runOrdinal: event.runOrdinal,
        failureItemOrdinal: stalled.ordinal,
        status: "failed",
        failure: { ...stalled.failure, retryable: false },
        retry: stalled.retry,
        ...(stalled.startedAt === null ? {} : { retryStartedAt: stalled.startedAt }),
        threadDisposition: event.threadDisposition,
      },
    };
  };
  return {
    track,
    // Runs for every provider event; spans would be per-event noise. Timers are children
    // of the pump fiber, so a released session takes them down.
    update: Effect.fnUntraced(function* (tracked: ReturnType<typeof track>) {
      const item = tracked.armed;
      if (item === undefined) {
        if (tracked.settled !== undefined) yield* stopStallTimer(tracked.settled);
        return;
      }
      yield* stopStallTimer(item.providerTurnId);
      const window = Duration.sum(
        PROVIDER_RETRY_STALL_TIMEOUT,
        Duration.millis(item.retry.retryDelayMs ?? 0),
      );
      const timer = yield* Effect.gen(function* () {
        // Only a thread that stayed silent for a whole window has stalled.
        do {
          activeSinceCheck.delete(item.providerTurnId);
          yield* Effect.sleep(window);
        } while (activeSinceCheck.has(item.providerTurnId));
        yield* stopStalledRetry(item);
      }).pipe(Effect.forkChild({ startImmediately: true }));
      stallTimers.set(item.providerTurnId, timer);
    }),
  };
};
