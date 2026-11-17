import { ORCHESTRATION_V2_WS_METHODS } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { awaitThreadState, snapshot } from "./threadsSyncFixtures.ts";
import { BASE_PROJECTION, CACHED_SNAPSHOT_SEQUENCE, makeHarness } from "./threadsSync.testkit.ts";

const DEFECT_MARKER = "Malformed snapshot";
const isMarker = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(
    (reason) =>
      reason._tag === "Fail" &&
      reason.error instanceof Error &&
      reason.error.message === DEFECT_MARKER,
  );

/**
 * Wraps the harness session: a marker error reaches the client as a stream defect (a chunk that
 * fails to decode), and each thread stream counts as open from its start to its end.
 */
const instrument = Effect.fn("TestThreadDefects.instrument")(function* (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
) {
  const open = yield* SubscriptionRef.make(0);
  const started = yield* SubscriptionRef.make(0);
  const session = Option.getOrThrow(yield* SubscriptionRef.get(harness.supervisorSession));
  const method = ORCHESTRATION_V2_WS_METHODS.subscribeThread;
  const subscribe = (
    session.client as unknown as Record<string, (input: unknown) => Stream.Stream<unknown, unknown>>
  )[method]!;
  const client = {
    ...session.client,
    [method]: (input: unknown) =>
      Stream.unwrap(
        SubscriptionRef.update(open, (count) => count + 1).pipe(
          Effect.andThen(SubscriptionRef.update(started, (count) => count + 1)),
          Effect.as(
            subscribe(input).pipe(
              Stream.catchCause((cause) =>
                isMarker(cause)
                  ? Stream.fromEffect(Effect.die(new Error(DEFECT_MARKER)))
                  : Stream.failCause(cause),
              ),
              Stream.ensuring(SubscriptionRef.update(open, (count) => count - 1)),
            ),
          ),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  yield* SubscriptionRef.set(harness.supervisorSession, Option.some({ ...session, client }));
  const reach = (ref: SubscriptionRef.SubscriptionRef<number>, count: number) =>
    SubscriptionRef.changes(ref).pipe(
      Stream.filter((value) => value === count),
      Stream.runHead,
    );
  yield* reach(started, 1);
  return { open, started, reach };
});

describe("EnvironmentThreads after a stream defect", () => {
  it.effect(
    "resubscribes after a snapshot decode defect ends the thread subscription (#23041)",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ httpSnapshot: { _tag: "unavailable" } });
        const streams = yield* instrument(harness);
        yield* Queue.offer(harness.inputs, new Error(DEFECT_MARKER));
        const failed = yield* awaitThreadState(harness.observed, (value) =>
          Option.isSome(value.error),
        );
        expect(failed.status).toBe("empty");
        expect(Option.getOrThrow(failed.error)).toBe("Could not synchronize the thread.");

        yield* TestClock.adjust("60 seconds");
        expect(yield* SubscriptionRef.get(streams.started)).toBe(2);

        yield* Queue.offer(
          harness.inputs,
          snapshot({
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Recovered thread" },
          }),
        );
        const recovered = yield* awaitThreadState(
          harness.observed,
          (value) =>
            value.status === "live" &&
            Option.isSome(value.data) &&
            value.data.value.thread.title === "Recovered thread",
        );
        expect(Option.isNone(recovered.error)).toBe(true);
        // The parked stream ended before its replacement opened.
        expect(yield* SubscriptionRef.get(streams.open)).toBe(1);
      }),
  );

  it.effect("keeps asking a mounted thread over HTTP after a miss until it exists", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshots: [
          { _tag: "missing" },
          { _tag: "missing" },
          {
            _tag: "present",
            snapshot: { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, projection: BASE_PROJECTION },
          },
        ],
      });
      yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");
      yield* TestClock.adjust("250 millis");
      yield* TestClock.adjust("500 millis");
      const state = yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(3);
    }),
  );

  it.effect("backs off repeated defects up to 30 seconds and keeps one stream open", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ httpSnapshot: { _tag: "unavailable" } });
      const streams = yield* instrument(harness);
      // 250 ms doubling: the eighth retry would wait 32 s uncapped, the ninth 64 s.
      for (let defect = 1; defect <= 9; defect += 1) {
        yield* Queue.offer(harness.inputs, new Error(DEFECT_MARKER));
        yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.error));
        yield* TestClock.adjust("30 seconds");
        expect(yield* SubscriptionRef.get(streams.started)).toBe(defect + 1);
        expect(yield* SubscriptionRef.get(streams.open)).toBe(1);
      }
    }),
  );
});
