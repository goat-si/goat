import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeOpenCode2ModelLoader } from "./status.ts";

it.effect("does not reuse models from another environment when the new probe times out", () =>
  Effect.gen(function* () {
    let profile = "one";
    const list = Effect.suspend(() =>
      profile === "one"
        ? Effect.succeed([{ providerID: "openai", id: "old", name: "Old", variants: [] }])
        : Effect.never,
    );
    const load = yield* makeOpenCode2ModelLoader(
      list,
      Effect.sync(() => profile),
    );
    const first = yield* load.pipe(Effect.forkChild);
    yield* TestClock.adjust("250 millis");
    NodeAssert.equal((yield* Fiber.join(first))[0]?.id, "old");
    profile = "two";
    const second = yield* load.pipe(Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    NodeAssert.deepEqual(yield* Fiber.join(second), []);
  }),
);
