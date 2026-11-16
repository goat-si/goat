import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { RpcSession } from "../rpc/session.ts";
import { latestSessionPublication, replacedSincePress } from "./sessionPublication.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { TARGET, awaitState, makeHarness } from "./supervisorTestSupport.ts";

describe("session publication", () => {
  it.effect(
    "each session the supervisor publishes replaces earlier presses, and not presses reacting to it",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const supervisor = yield* EnvironmentSupervisor.make(
          { target: TARGET, profile: Option.none(), enabled: true },
          { initiallyDesired: false },
        ).pipe(Effect.provide(harness.dependencies));
        const beforeFirst = latestSessionPublication();
        // A press made by whatever reacts to a new session, such as the model migration.
        const reactions = yield* Queue.unbounded<{
          readonly session: RpcSession;
          readonly pressedAt: number;
        }>();
        yield* SubscriptionRef.changes(supervisor.session).pipe(
          Stream.filter(Option.isSome),
          Stream.map((session) => session.value),
          Stream.runForEach((session) =>
            Queue.offer(reactions, { session, pressedAt: latestSessionPublication() }),
          ),
          Effect.forkScoped,
        );

        yield* supervisor.connect;
        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        const first = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
        const reactionToFirst = yield* Queue.take(reactions);
        const pressedOnFirst = latestSessionPublication();
        yield* harness.closeLatestSession();
        yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        yield* TestClock.adjust("3 seconds");
        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 2,
        );
        const second = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
        const reactionToSecond = yield* Queue.take(reactions);

        expect(second).not.toBe(first);
        expect(replacedSincePress(TARGET.environmentId, first, beforeFirst)).toBe(false);
        expect(replacedSincePress(TARGET.environmentId, first, pressedOnFirst)).toBe(false);
        expect(replacedSincePress(TARGET.environmentId, second, pressedOnFirst)).toBe(true);
        expect([reactionToFirst.session, reactionToSecond.session]).toEqual([first, second]);
        for (const reaction of [reactionToFirst, reactionToSecond]) {
          expect(
            replacedSincePress(TARGET.environmentId, reaction.session, reaction.pressedAt),
          ).toBe(false);
        }
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );
});
