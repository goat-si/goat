import { assert, it } from "@effect/vitest";
import { MessageId } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  captureRootRunTermination,
  backgroundScenarioIds,
  driver,
  rootTerminalEvent,
} from "./RunExecutionService.testkit.ts";

it.effect("publishes a quiet paragraph during an open turn, but not while it grows", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ids = backgroundScenarioIds("idle-paragraph");
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const barriers = yield* Queue.unbounded<string>();
      const shown = yield* Ref.make<ReadonlyArray<string>>([]);
      const now = yield* DateTime.now;
      const snapshot = (
        text: string,
        role: "assistant" | "user" = "assistant",
        streaming = role === "assistant",
      ): ProviderAdapter.ProviderAdapterV2Event => ({
        type: "message.updated",
        driver,
        message: {
          createdBy: role === "assistant" ? "agent" : "user",
          creationSource: role === "assistant" ? "provider" : "web",
          id: MessageId.make(role),
          threadId: ids.threadId,
          runId: ids.runId,
          nodeId: ids.rootNodeId,
          role,
          text,
          attachments: [],
          streaming,
          createdAt: now,
          updatedAt: now,
        },
      });
      const scenario = yield* captureRootRunTermination({
        key: "idle-paragraph",
        shouldFinalizeRun: () => Effect.succeed(true),
        events: () => Stream.fromQueue(events),
        ingestNormalized: ({ event }) =>
          Effect.gen(function* () {
            if (event.type === "message.updated") {
              if (event.message.role === "user") yield* Queue.offer(barriers, event.message.text);
              else yield* Ref.update(shown, (current) => [...current, event.message.text]);
            }
            return [];
          }),
      }).pipe(Effect.forkScoped);
      yield* Queue.offerAll(events, [snapshot("First"), snapshot("first-read", "user")]);
      assert.equal(yield* Queue.take(barriers), "first-read");
      yield* TestClock.adjust("600 millis");
      yield* Queue.offerAll(events, [snapshot("First grows"), snapshot("second-read", "user")]);
      assert.equal(yield* Queue.take(barriers), "second-read");
      yield* TestClock.adjust("600 millis");
      assert.deepEqual(yield* Ref.get(shown), []);
      yield* TestClock.adjust("200 millis");
      assert.deepEqual(yield* Ref.get(shown), ["First grows"]);
      yield* Queue.offerAll(events, [snapshot("First grows more"), snapshot("third-read", "user")]);
      assert.equal(yield* Queue.take(barriers), "third-read");
      yield* Queue.offerAll(events, [
        snapshot("Finished", "assistant", false),
        rootTerminalEvent(ids, "completed"),
      ]);
      yield* Fiber.join(scenario);
      yield* TestClock.adjust("1 second");
      assert.deepEqual(yield* Ref.get(shown), ["First grows", "Finished"]);
    }),
  ),
);
