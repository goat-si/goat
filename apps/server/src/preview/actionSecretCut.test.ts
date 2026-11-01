import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { SessionControl } from "./SessionControl.ts";

it.effect("a blocked cut interrupts secret target preparation", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const latch = Promise.withResolvers<void>();
    yield* Effect.forkChild(
      Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
    );
    const control = new SessionControl("agent");
    const action = control.secret("agent", async (fence) => {
      Deferred.doneUnsafe(entered, Effect.void);
      await latch.promise;
      fence.assertMayDispatch();
      return "sent";
    });
    yield* Deferred.await(entered);
    control.cutBlockedUrl();
    yield* Deferred.succeed(resume, undefined);
    const result = yield* Effect.promise(() =>
      action.then(
        () => null,
        (cause: unknown) => cause,
      ),
    );
    expect(result).toMatchObject({ reason: "blocked_url" });
  }),
);
