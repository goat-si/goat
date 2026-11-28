import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makePrLookupFlights } from "./prLookupFlights.ts";

const request = {
  cwd: "/repo",
  branch: "feature",
  refresh: false,
  freshGitState: true,
  confirmTerminal: true,
};

it.effect("concurrent identical lookups share one run, but never across newer git state", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const state = { epoch: 0, reads: 0 };
    let runs = 0;
    const lookup = yield* makePrLookupFlights(
      () =>
        Effect.sync(() => ++runs).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Deferred.await(release)),
          Effect.as("pull request"),
        ),
      () => state,
    );
    // Each caller runs until it waits on a lookup before the next one starts.
    const start = <A>(effect: Effect.Effect<A>) =>
      Effect.forkChild(effect, { startImmediately: true });
    const joined = yield* Effect.forEach(Array.from({ length: 4 }), () => start(lookup(request)));
    yield* Deferred.await(started);
    const refreshed = yield* start(lookup({ ...request, refresh: true }));
    state.reads = 1;
    const afterNewerRead = yield* start(lookup(request));
    yield* Deferred.succeed(release, undefined);
    assert.deepEqual(yield* Fiber.joinAll(joined), Array(4).fill("pull request"));
    assert.equal(yield* Fiber.join(refreshed), "pull request");
    assert.equal(yield* Fiber.join(afterNewerRead), "pull request");
    assert.equal(runs, 3);
    // Nothing outlives a run.
    yield* lookup(request);
    assert.equal(runs, 4);
  }),
);
