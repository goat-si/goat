import { EnvironmentAuthorizationError } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { BASE_PROJECTION, makeHarness } from "./threadsSync.testkit.ts";
import { awaitThreadState } from "./threadsSyncFixtures.ts";

const preparedThread = {
  _tag: "present",
  snapshot: { projection: BASE_PROJECTION, snapshotSequence: 7 },
} as const;
const waitForSubscription = (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  count: number,
) =>
  SubscriptionRef.changes(harness.subscriptionCount).pipe(
    Stream.filter((value) => value >= count),
    Stream.runHead,
  );

it.effect(
  "opens a cold paginated thread over the socket and retries a failed open over HTTP once",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        threadSnapshotPagination: true,
        httpSnapshot: preparedThread,
      });
      yield* waitForSubscription(h, 1);
      expect(yield* Ref.get(h.loaderCalls)).toBe(0);
      expect(yield* Ref.get(h.lastAcceptBoundedSnapshot)).toBe(true);
      yield* Queue.offer(h.inputs, new Error("cold stream failed"));
      yield* TestClock.adjust("1 second");
      yield* waitForSubscription(h, 2);
      expect(yield* Ref.get(h.loaderCalls)).toBe(1);
      expect(yield* Ref.get(h.lastSubscribeAfterSequence)).toBe(7);
    }),
);

it.effect("does not retry a cold socket authorization denial over HTTP", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ threadSnapshotPagination: true, httpSnapshot: preparedThread });
    yield* waitForSubscription(h, 1);
    expect(yield* Ref.get(h.loaderCalls)).toBe(0);
    yield* Queue.offer(
      h.inputs,
      new EnvironmentAuthorizationError({
        message: "Forbidden",
        requiredScope: "orchestration:read",
      }),
    );
    yield* awaitThreadState(h.observed, (state) => Option.isSome(state.error));
    yield* TestClock.adjust("1 second");
    expect(yield* Ref.get(h.loaderCalls)).toBe(0);
    expect(yield* SubscriptionRef.get(h.subscriptionCount)).toBe(1);
  }),
);
