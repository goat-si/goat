import { EventId } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { awaitThreadState, snapshot } from "./threadsSyncFixtures.ts";
import {
  BASE_PROJECTION,
  CACHED_SNAPSHOT_SEQUENCE,
  THREAD_ID,
  makeHarness,
} from "./threadsSync.testkit.ts";

// Fault injection: no real event makes the fold throw, so one marked event does.
const fault = vi.hoisted(() => ({ armed: false }));
vi.mock("./orchestrationV2Projection.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./orchestrationV2Projection.ts")>();
  return {
    ...real,
    applyOrchestrationV2ProjectionEvent: (
      ...args: Parameters<typeof real.applyOrchestrationV2ProjectionEvent>
    ) => {
      if (fault.armed && (args[1] as { readonly id?: string }).id === "event-boom") {
        throw new Error("reducer defect");
      }
      return real.applyOrchestrationV2ProjectionEvent(...args);
    },
  };
});

describe("thread subscription after a defect while applying events", () => {
  it.effect("resubscribes for a fresh snapshot, never past the batch it did not apply", () =>
    Effect.gen(function* () {
      fault.armed = false;
      const harness = yield* makeHarness({ httpSnapshot: { _tag: "unavailable" } });
      yield* SubscriptionRef.changes(harness.subscriptionCount).pipe(
        Stream.filter((count) => count >= 1),
        Stream.runHead,
      );
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION, CACHED_SNAPSHOT_SEQUENCE));
      yield* awaitThreadState(harness.observed, (state) => Option.isSome(state.data));

      fault.armed = true;
      yield* Queue.offer(harness.inputs, {
        kind: "event",
        sequence: CACHED_SNAPSHOT_SEQUENCE + 1,
        event: {
          id: EventId.make("event-boom"),
          type: "thread.meta-updated",
          threadId: THREAD_ID,
          occurredAt: "2026-01-01T00:00:00.000Z",
          payload: { title: "Lost title" },
        },
      } as never);
      yield* awaitThreadState(harness.observed, (state) => Option.isSome(state.error));
      yield* TestClock.adjust("1 second");
      yield* SubscriptionRef.changes(harness.subscriptionCount).pipe(
        Stream.filter((count) => count >= 2),
        Stream.runHead,
      );

      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBeUndefined();

      yield* harness.replaceSession;
      yield* SubscriptionRef.changes(harness.subscriptionCount).pipe(
        Stream.filter((count) => count >= 3),
        Stream.runHead,
      );
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBeUndefined();

      fault.armed = false;
      yield* Queue.offer(
        harness.inputs,
        snapshot(
          { ...BASE_PROJECTION, thread: { ...BASE_PROJECTION.thread, title: "Lost title" } },
          CACHED_SNAPSHOT_SEQUENCE + 1,
        ),
      );
      const recovered = yield* awaitThreadState(
        harness.observed,
        (state) => Option.isSome(state.data) && state.data.value.thread.title === "Lost title",
      );
      expect(Option.getOrThrow(recovered.data).thread.title).toBe("Lost title");

      yield* harness.replaceSession;
      yield* SubscriptionRef.changes(harness.subscriptionCount).pipe(
        Stream.filter((count) => count >= 4),
        Stream.runHead,
      );
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
    }),
  );
});
