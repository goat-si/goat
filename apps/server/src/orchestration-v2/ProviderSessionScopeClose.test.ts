import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";

import { makeScopeCloser } from "./ProviderSessionScopeClose.ts";

/** A session scope whose close is held, as while its agent process is still exiting. */
const makeHeldSessionScope = Effect.gen(function* () {
  const scope = yield* Scope.make();
  const closing = yield* Deferred.make<void>();
  const exited = yield* Deferred.make<void>();
  const state = { closed: false };
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      state.closed = true;
    }),
  );
  yield* Scope.addFinalizer(
    scope,
    Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(exited))),
  );
  return { scope, closing, exited, state };
});

const releaseUntilTimeout = (
  closer: ReturnType<typeof makeScopeCloser>,
  session: Effect.Success<typeof makeHeldSessionScope>,
) =>
  Effect.gen(function* () {
    const release = yield* closer
      .closeWithin(session.scope, { reason: "idle_timeout" })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(session.closing);
    yield* TestClock.adjust("30 seconds");
    assert.isTrue(Option.isNone(yield* Fiber.join(release)));
  });

it.effect("shutdown waits for a session close that outlived its release", () =>
  Effect.gen(function* () {
    const closer = makeScopeCloser(30_000);
    const session = yield* makeHeldSessionScope;
    yield* releaseUntilTimeout(closer, session);

    yield* Effect.sleep("5 seconds").pipe(
      Effect.andThen(Deferred.succeed(session.exited, undefined)),
      Effect.forkChild({ startImmediately: true }),
    );
    const shutdown = yield* closer.awaitLateCloses.pipe(
      Effect.andThen(Effect.sync(() => session.state.closed)),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* TestClock.adjust("5 seconds");
    assert.isTrue(yield* Fiber.join(shutdown));
  }),
);

it.effect("shutdown stops waiting for a close that never finishes after the same bound", () =>
  Effect.gen(function* () {
    const closer = makeScopeCloser(30_000);
    const session = yield* makeHeldSessionScope;
    yield* releaseUntilTimeout(closer, session);

    const shutdown = yield* closer.awaitLateCloses.pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* TestClock.adjust("30 seconds");
    yield* Fiber.join(shutdown);
    assert.isFalse(session.state.closed);
  }),
);
