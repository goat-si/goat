import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderSessionId } from "@goat/contracts";
import { ProviderAdapterEventStreamError } from "@goat/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import {
  makeProviderSessionEventSubscription,
  type ProviderSessionEventSignal,
} from "./providerSessionEventSubscription.ts";

it.effect.each(["provider stop", "provider failure"] as const)(
  "waits for release settlement before completing a drained subscription after %s",
  (terminal) =>
    Effect.gen(function* () {
      type SubscriberQueue = Queue.Queue<ProviderSessionEventSignal, Cause.Done>;
      const subscribers = yield* Ref.make<ReadonlyMap<number, SubscriberQueue>>(new Map());
      const nextSubscriberId = yield* Ref.make(0);
      const cleanup = new WeakMap<SubscriberQueue, Effect.Effect<void>>();
      const subscription = yield* makeProviderSessionEventSubscription(
        subscribers,
        nextSubscriberId,
        cleanup,
      );
      const queue = (yield* Ref.getAndSet(subscribers, new Map())).get(0);
      if (queue === undefined) return assert.fail("missing subscriber");
      const settling = yield* Deferred.make<void>();
      const allowSettlement = yield* Deferred.make<void>();
      cleanup.set(
        queue,
        Deferred.succeed(settling, undefined).pipe(Effect.andThen(Deferred.await(allowSettlement))),
      );
      const failure = new ProviderAdapterEventStreamError({
        driver: ProviderDriverKind.make("codex"),
        providerSessionId: ProviderSessionId.make("fixture-session"),
        cause: "fixture provider closed",
      });
      const consumer = yield* subscription.events.pipe(
        Stream.runDrain,
        Effect.exit,
        Effect.forkChild,
      );
      if (terminal === "provider stop") yield* Queue.end(queue);
      else yield* Queue.offer(queue, { type: "failure", cause: Cause.fail(failure) });

      yield* Effect.gen(function* () {
        yield* Deferred.await(settling);
        assert.isUndefined(consumer.pollUnsafe(), "the drain returned before settlement");
      }).pipe(Effect.ensuring(Deferred.succeed(allowSettlement, undefined)));
      assert.deepStrictEqual(
        yield* Fiber.join(consumer),
        terminal === "provider stop" ? Exit.void : Exit.fail(failure),
      );
    }),
);
