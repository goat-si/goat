import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { makeDesktopControlWriter } from "./DesktopControlWriter.ts";
it.effect("scope shutdown settles requests without waiting for a held native frame", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writes: string[] = [];
      const writer = yield* makeDesktopControlWriter({
        write: (payload) =>
          Effect.sync(() => writes.push(payload.toString())).pipe(
            Effect.andThen(Deferred.succeed(writing, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        overflow: () => new Error("admission closed"),
      }).pipe(Scope.provide(scope));
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(release, undefined).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
      );
      const first = yield* writer.send(Buffer.from("partial-frame\n")).pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      const pending = yield* writer
        .send(Buffer.from("next-frame\n"))
        .pipe(Effect.forkChild({ startImmediately: true }));
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("0 millis");
      assert.isTrue((yield* writer.state).closed);
      assert.isDefined(closing.pollUnsafe());
      assert.isTrue(Exit.isFailure(yield* Fiber.await(first)));
      assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
      assert.isTrue(
        Exit.isFailure(yield* writer.send(Buffer.from("late-frame\n")).pipe(Effect.exit)),
      );
      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust("0 millis");
      assert.deepEqual(writes, ["partial-frame\n"]);
    }),
  ),
);
it.effect("overflow fails pending requests while a held native frame stays charged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* makeDesktopControlWriter({
        write: () =>
          Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(release))),
        overflow: () => new Error("admission closed"),
      });
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      const requests: Array<Fiber.Fiber<void, Error>> = [];
      const first = yield* writer.send(Buffer.from("first\n")).pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      for (let index = 1; index < 32; index++) {
        requests.push(
          yield* writer
            .send(Buffer.from(`frame-${index}\n`))
            .pipe(Effect.forkChild({ startImmediately: true })),
        );
      }
      assert.equal((yield* writer.state).frames, 32);
      const refused = yield* writer.send(Buffer.from("overflow\n")).pipe(Effect.result);
      assert.equal(refused._tag, "Failure");
      assert.isAtMost((yield* writer.state).bytes, 65536);
      assert.equal((yield* writer.state).frames, 1);
      assert.isTrue((yield* writer.state).closed);
      assert.equal((yield* Fiber.await(first))._tag, "Failure");
      for (const request of requests) assert.equal((yield* Fiber.await(request))._tag, "Failure");
      yield* Deferred.succeed(release, undefined);
    }),
  ),
);
