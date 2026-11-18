import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeCodexThreadClosings } from "./CodexThreadClosings.ts";

it.effect("releases a waiting resume when the bounded closing registry evicts its thread", () =>
  Effect.gen(function* () {
    const closings = makeCodexThreadClosings();
    yield* closings.begin("oldest");
    const waiting = yield* closings
      .wait("oldest")
      .pipe(Effect.forkScoped({ startImmediately: true }));
    for (let index = 0; index < 256; index++) yield* closings.begin(`thread-${index}`);
    yield* Fiber.join(waiting);
  }).pipe(Effect.scoped),
);
