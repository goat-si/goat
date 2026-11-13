import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

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

it.effect("closing the scope stops a running pass and releases its waiters", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const shared = makeSharedPasses(scope, 4);
    const started = yield* Deferred.make<void>();
    const done = yield* shared(
      "all",
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    );
    yield* Deferred.await(started);
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.await(done);
  }),
);
