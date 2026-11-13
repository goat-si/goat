import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeSharedPasses } from "./sharedPasses.ts";

it.effect("a pass that dies releases its waiters, and the next call starts a new pass", () =>
  Effect.gen(function* () {
    const shared = makeSharedPasses(yield* Effect.scope, 4);
    let runs = 0;
    const dying = Effect.suspend(() => {
      runs += 1;
      return Effect.die(new Error("boom"));
    });
    yield* Effect.flatMap(shared("all", dying), Deferred.await);
    yield* Effect.flatMap(shared("all", dying), Deferred.await);
    expect(runs).toBe(2);
  }),
);
