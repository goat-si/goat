import { EnvironmentId, type ServerLifecycleStreamEvent, WS_METHODS } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "./session.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import { subscribe } from "./client.ts";

const decodeNumber = Schema.decodeUnknownEffect(Schema.Number);
const RESUBSCRIBING = "Durable RPC subscription stream ended; resubscribing.";

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  } as unknown as RpcSession.RpcSession;
}

const makeHarness = Effect.fn("TestStreamRecovery.makeHarness")(function* () {
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.none(),
  );
  const retryCount = yield* Ref.make(0);
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("environment-1"),
      label: "Test environment",
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE),
    session: activeSession,
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return { activeSession, retryCount, supervisor };
});

const transportFailure = () =>
  Stream.fail(
    new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "stream failed",
        cause: new Error("stream failed"),
      }),
    }),
  );

describe("durable subscriptions on a healthy session", () => {
  // The session stays healthy (`closed` never resolves), as when one stream chunk fails to decode,
  // so the supervisor will not replace it and only resubscribing restores delivery.
  const resumesOnTheSameSession = Effect.fn("TestStreamRecovery.resumesOnTheSameSession")(
    function* (streamFailure: Stream.Stream<never, unknown>) {
      const resumedValue = { source: "resumed" } as unknown as ServerLifecycleStreamEvent;
      const firstSubscribed = yield* Deferred.make<void>();
      let subscriptions = 0;
      const client = {
        [WS_METHODS.subscribeServerLifecycle]: () => {
          subscriptions += 1;
          return subscriptions === 1
            ? Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(
                Stream.drain,
                Stream.concat(streamFailure),
              )
            : Stream.make(resumedValue).pipe(Stream.concat(Stream.never));
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const resultFiber = yield* subscribe(WS_METHODS.subscribeServerLifecycle, {}).pipe(
        Stream.runHead,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(firstSubscribed);
      yield* TestClock.adjust("2 seconds");

      expect(
        resultFiber.pollUnsafe(),
        "durable subscription stopped delivering after its stream ended on a healthy session",
      ).toBeDefined();
      expect(yield* Fiber.join(resultFiber)).toEqual(Option.some(resumedValue));
      expect(subscriptions).toBe(2);
      expect(yield* Ref.get(retryCount)).toBe(0);
    },
  );

  it.effect("resubscribes on the same session after a transport failure", () =>
    resumesOnTheSameSession(transportFailure()),
  );

  it.effect("resubscribes on the same session after a stream chunk fails to decode", () =>
    // Mirrors RpcClient, which decodes each chunk with `Effect.orDie`.
    resumesOnTheSameSession(
      Stream.fromEffect(decodeNumber("not a number").pipe(Effect.orDie)).pipe(Stream.drain),
    ),
  );

  it.effect(
    "backs off a same-session stream that keeps failing to decode after its first value",
    () =>
      Effect.gen(function* () {
        // Like the shell stream: a valid value (metadata) arrives, then a chunk fails to decode.
        const value = { source: "metadata" } as unknown as ServerLifecycleStreamEvent;
        const decodeDefect = decodeNumber("not a number").pipe(Effect.orDie);
        const subscriptions = yield* Queue.unbounded<{
          readonly session: "first" | "second";
          readonly at: number;
        }>();
        let secondSubscriptions = 0;
        const failingClient = (name: "first" | "second") =>
          ({
            [WS_METHODS.subscribeServerLifecycle]: () =>
              Stream.unwrap(
                Effect.gen(function* () {
                  yield* Queue.offer(subscriptions, {
                    session: name,
                    at: yield* Clock.currentTimeMillis,
                  });
                  if (name === "second" && ++secondSubscriptions > 2) return Stream.never;
                  return Stream.make(value).pipe(
                    Stream.concat(Stream.fromEffect(decodeDefect).pipe(Stream.drain)),
                  );
                }),
              ),
          }) as unknown as WsRpcProtocolClient;
        const { activeSession, retryCount, supervisor } = yield* makeHarness();

        yield* SubscriptionRef.set(activeSession, Option.some(session(failingClient("first"))));
        const subscriptionFiber = yield* subscribe(
          WS_METHODS.subscribeServerLifecycle,
          {},
          {
            onExpectedFailure: () => Effect.void,
            retryExpectedFailureAfter: "250 millis",
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );

        const expectedFirstSessionDelays = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
        const firstSessionDelays: number[] = [];
        let previous = yield* Queue.take(subscriptions);
        for (const delay of expectedFirstSessionDelays) {
          yield* TestClock.adjust(delay);
          const next = yield* Queue.take(subscriptions);
          firstSessionDelays.push(next.at - previous.at);
          previous = next;
        }

        // A replacement session starts a fresh backoff.
        yield* SubscriptionRef.set(activeSession, Option.some(session(failingClient("second"))));
        const replaced = yield* Queue.take(subscriptions);
        yield* TestClock.adjust(250);
        const retried = yield* Queue.take(subscriptions);
        yield* Fiber.interrupt(subscriptionFiber);

        expect(
          firstSessionDelays,
          "same-session decode retries reset to the base delay after every first value",
        ).toEqual(expectedFirstSessionDelays);
        expect([replaced.session, retried.session]).toEqual(["second", "second"]);
        expect(retried.at - replaced.at).toBe(250);
        expect(yield* Ref.get(retryCount)).toBe(0);
      }),
  );

  it.effect("a repeating decode defect logs once per retry and keeps one stream open", () =>
    Effect.gen(function* () {
      const logs: unknown[] = [];
      const open = yield* SubscriptionRef.make(0);
      const subscribed = yield* Queue.unbounded<void>();
      const client = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.unwrap(
            SubscriptionRef.update(open, (count) => count + 1).pipe(
              Effect.andThen(Queue.offer(subscribed, undefined)),
              Effect.as(
                Stream.fromEffect(decodeNumber("not a number").pipe(Effect.orDie)).pipe(
                  Stream.drain,
                  Stream.ensuring(SubscriptionRef.update(open, (count) => count - 1)),
                ),
              ),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeServerLifecycle, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provide(
          Logger.layer([Logger.make(({ message }) => logs.push(message))], {
            mergeWithExisting: false,
          }),
        ),
        Effect.forkChild,
      );
      yield* Queue.take(subscribed);
      // 1 s doubling: four retries take 1 + 2 + 4 + 8 seconds.
      for (const delay of [1_000, 2_000, 4_000, 8_000]) {
        yield* TestClock.adjust(delay);
        yield* Queue.take(subscribed);
        expect(yield* SubscriptionRef.get(open)).toBeLessThanOrEqual(1);
      }
      yield* Fiber.interrupt(subscriptionFiber);

      // The first stream and its four retries each failed once, and each failure logged once.
      const resubscribing = logs.filter(
        (message) => Array.isArray(message) && message[0] === RESUBSCRIBING,
      );
      expect(resubscribing).toHaveLength(5);
    }),
  );

  it.effect("a pending same-session retry does not resubscribe a session that was replaced", () =>
    Effect.gen(function* () {
      const subscriptions: Array<"first" | "second"> = [];
      const subscribed = yield* Queue.unbounded<void>();
      const clientFor = (name: "first" | "second") =>
        ({
          [WS_METHODS.subscribeServerLifecycle]: () =>
            Stream.unwrap(
              Effect.sync(() => subscriptions.push(name)).pipe(
                Effect.andThen(Queue.offer(subscribed, undefined)),
                Effect.as(name === "first" ? transportFailure() : Stream.never),
              ),
            ),
        }) as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();
      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeServerLifecycle, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(clientFor("first"))));
      yield* Queue.take(subscribed);
      yield* SubscriptionRef.set(activeSession, Option.some(session(clientFor("second"))));
      yield* Queue.take(subscribed);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("waits for the next session when an older server does not have the method", () =>
    Effect.gen(function* () {
      const subscribed = yield* Queue.unbounded<void>();
      let subscriptions = 0;
      const client = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.unwrap(
            Effect.sync(() => (subscriptions += 1)).pipe(
              Effect.andThen(Queue.offer(subscribed, undefined)),
              Effect.as(
                Stream.fail(
                  new RpcClientError.RpcClientError({
                    reason: new RpcClientError.RpcClientDefect({
                      message: `Unknown request tag: ${WS_METHODS.subscribeServerLifecycle}`,
                      cause: new Error(
                        `Unknown request tag: ${WS_METHODS.subscribeServerLifecycle}`,
                      ),
                    }),
                  }),
                ),
              ),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeServerLifecycle, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Queue.take(subscribed);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toBe(1);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );
  it.effect(
    "a caller with onDefect owns a decode defect: one report and no same-session resubscribe",
    () =>
      Effect.gen(function* () {
        const subscribed = yield* Deferred.make<void>();
        let subscriptions = 0;
        let defects = 0;
        const client = {
          [WS_METHODS.subscribeServerLifecycle]: () => {
            subscriptions += 1;
            return Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
              Stream.drain,
              Stream.concat(
                Stream.fromEffect(decodeNumber("not a number").pipe(Effect.orDie)).pipe(
                  Stream.drain,
                ),
              ),
            );
          },
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();
        yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

        const fiber = yield* subscribe(
          WS_METHODS.subscribeServerLifecycle,
          {},
          {
            onDefect: () =>
              Effect.sync(() => {
                defects += 1;
              }),
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);
        yield* TestClock.adjust("2 minutes");

        expect(subscriptions).toBe(1);
        expect(defects).toBe(1);
        yield* Fiber.interrupt(fiber);
      }),
  );
  it.effect("a stream that stayed up a minute retries its next failure after the base delay", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const subscriptionCount = yield* SubscriptionRef.make(0);
      const decodeDefect = Stream.fromEffect(decodeNumber("not a number").pipe(Effect.orDie)).pipe(
        Stream.drain,
      );
      const client = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.unwrap(
            SubscriptionRef.updateAndGet(subscriptionCount, (count) => count + 1).pipe(
              Effect.map((count) =>
                count <= 5
                  ? decodeDefect
                  : count === 6
                    ? Stream.fromEffect(Deferred.await(release)).pipe(
                        Stream.drain,
                        Stream.concat(decodeDefect),
                      )
                    : Stream.never,
              ),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const reach = (count: number) =>
        SubscriptionRef.changes(subscriptionCount).pipe(
          Stream.filter((value) => value >= count),
          Stream.runHead,
        );

      const fiber = yield* subscribe(WS_METHODS.subscribeServerLifecycle, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      // Five quick failures: 1, 2, 4, 8 and 16 s, so the next would wait the 30 s cap.
      for (let count = 1; count <= 5; count += 1) {
        yield* reach(count);
        yield* TestClock.adjust("30 seconds");
      }
      yield* reach(6);
      yield* TestClock.adjust("60 seconds");
      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust("1 second");

      expect(yield* SubscriptionRef.get(subscriptionCount)).toBe(7);
      yield* Fiber.interrupt(fiber);
    }),
  );
});
