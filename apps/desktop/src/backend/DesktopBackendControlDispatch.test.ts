import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { makeControlDispatch } from "./DesktopBackendControlDispatch.ts";
it.effect("charges held executing work, coalesces state and refuses overflow", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      const dispatch = yield* makeControlDispatch({
        handle: () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        onFailure: () => Effect.void,
      });
      assert.isTrue(
        yield* dispatch.offer({ version: 1, type: "setDiagnosticsDemand", enabled: true }),
      );
      yield* Deferred.await(entered);
      for (let n = 0; n < 100; n++)
        yield* dispatch.offer({ version: 1, type: "setDiagnosticsDemand", enabled: n % 2 === 0 });
      assert.equal((yield* dispatch.state).frames, 2);
      yield* Deferred.succeed(release, undefined);
    }),
  ),
);
