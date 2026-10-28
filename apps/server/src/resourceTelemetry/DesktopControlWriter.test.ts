import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { makeDesktopControlWriter } from "./DesktopControlWriter.ts";
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
