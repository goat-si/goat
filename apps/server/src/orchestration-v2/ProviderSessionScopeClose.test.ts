import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
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
    const shutdown = yield* closer.awaitPendingReleases.pipe(
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

    const shutdown = yield* closer.awaitPendingReleases.pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* TestClock.adjust("30 seconds");
    yield* Fiber.join(shutdown);
    assert.isFalse(session.state.closed);
  }),
);

it.effect("shutdown waits for a release that starts its close while shutdown waits", () =>
  Effect.gen(function* () {
    const closer = makeScopeCloser(30_000);
    const first = yield* makeHeldSessionScope;
    const second = yield* makeHeldSessionScope;
    yield* releaseUntilTimeout(closer, first);
    // The second release has removed its session but not yet started its close.
    const removed = yield* Deferred.make<void>();
    yield* closer
      .trackRelease(
        Deferred.await(removed).pipe(
          Effect.andThen(closer.closeWithin(second.scope, { reason: "idle_timeout" })),
        ),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.sleep("5 seconds").pipe(
      Effect.andThen(Deferred.succeed(removed, undefined)),
      Effect.andThen(Deferred.succeed(first.exited, undefined)),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.sleep("10 seconds").pipe(
      Effect.andThen(Deferred.succeed(second.exited, undefined)),
      Effect.forkChild({ startImmediately: true }),
    );
    const shutdown = yield* closer.awaitPendingReleases.pipe(
      Effect.andThen(Effect.sync(() => [first.state.closed, second.state.closed])),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* TestClock.adjust("10 seconds");
    assert.deepEqual(yield* Fiber.join(shutdown), [true, true]);
  }),
);

const optedIn = { reopenAfterClose: true as const };

it.effect("a reopen waits for a hold registered while it looked up the session", () =>
  Effect.gen(function* () {
    const closer = makeScopeCloser(30_000);
    const released = yield* Deferred.make<void>();
    const lookups = yield* Ref.make(0);
    const scope = yield* Scope.make();
    // A release of the same key starts between the reopen's wait and its lookup.
    const lookup = Ref.getAndUpdate(lookups, (count) => count + 1).pipe(
      Effect.tap((count) =>
        count > 0
          ? Effect.void
          : closer
              .holdReopen("session", (latch) =>
                latch
                  .keepFor({ runtime: optedIn, scope })
                  .pipe(Effect.andThen(Deferred.await(released))),
              )
              .pipe(Effect.forkChild({ startImmediately: true })),
      ),
    );
    const reopen = yield* closer
      .awaitReopen("session", lookup)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("10 seconds");
    assert.strictEqual(yield* Ref.get(lookups), 1);

    yield* Deferred.succeed(released, undefined);
    assert.isTrue(Option.isSome(yield* Fiber.join(reopen)));
    assert.strictEqual(yield* Ref.get(lookups), 2);
  }),
);

it.effect("an interrupted release still closes the scope it removed before a reopen proceeds", () =>
  Effect.gen(function* () {
    const closer = makeScopeCloser(30_000);
    const session = yield* makeHeldSessionScope;
    const removed = yield* Deferred.make<void>();
    const release = yield* closer
      .holdReopen("session", (latch) =>
        latch
          .keepFor({ runtime: optedIn, scope: session.scope })
          .pipe(Effect.andThen(Deferred.succeed(removed, undefined)), Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(removed);
    yield* Fiber.interrupt(release);
    yield* Deferred.await(session.closing);

    const reopen = yield* closer
      .awaitReopen(
        "session",
        Effect.sync(() => session.state.closed),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(session.exited, undefined);
    assert.deepEqual(yield* Fiber.join(reopen), Option.some(true));
  }),
);
