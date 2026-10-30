import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import { watchClick } from "./clickEffect.ts";
import { SessionControl } from "./SessionControl.ts";

it.effect("a blocked cut prevents click watcher cleanup from sending new commands", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      const frame = page.mainFrame();
      const installing = vi.spyOn(frame, "evaluateHandle");
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const control = new SessionControl("agent");
      const action = control.agent("agent", async (signal) => {
        const watch = await watchClick(
          page,
          frame,
          Object.assign(control.dispatchGate(), { signal }),
        );
        Deferred.doneUnsafe(entered, Effect.void);
        await latch.promise;
        watch.cancel();
      });
      void action.catch(() => undefined);
      yield* Deferred.await(entered);
      const pending = installing.mock.results[0];
      if (!pending || pending.type !== "return") throw new Error("watch was not installed");
      const handle = yield* Effect.promise(() => pending.value);
      const evaluate = vi.spyOn(handle, "evaluate");
      const dispose = vi.spyOn(handle, "dispose");
      control.cutBlockedUrl();
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Effect.promise(() =>
        action.then(
          () => null,
          (error: unknown) => error,
        ),
      );
      yield* Effect.promise(() => control.system(async () => {}));
      expect(result).toMatchObject({ reason: "blocked_url" });
      expect(evaluate).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
    }),
  ),
);
