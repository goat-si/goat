import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

it.effect("keeps a same-version offer visible and queues a download behind the refresh", () =>
  Effect.gen(function* () {
    const checkStarted = yield* Deferred.make<void>();
    const finishCheck = yield* Deferred.make<void>();
    const harness = makeHarness({
      checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
        Effect.andThen(Deferred.await(finishCheck)),
        Effect.andThen(Effect.sync(() => harness.emit("update-available", { version: "1.2.4" }))),
      ),
    });
    yield* Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      harness.emit("update-available", { version: "1.2.4", releaseNotes: "fix: queued update" });
      yield* flushCallbacks;
      const before = yield* updates.getState;
      const check = yield* updates.check("poll").pipe(Effect.forkScoped);
      yield* Deferred.await(checkStarted);
      assert.deepEqual(yield* updates.getState, before);
      const download = yield* updates.download.pipe(Effect.forkScoped);
      yield* flushCallbacks;
      assert.isUndefined(download.pollUnsafe());
      yield* Deferred.succeed(finishCheck, undefined);
      assert.isTrue((yield* Fiber.join(check)).checked);
      assert.isTrue((yield* Fiber.join(download)).accepted);
      assert.equal(harness.downloadCount(), 1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);
