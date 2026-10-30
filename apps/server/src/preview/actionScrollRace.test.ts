import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import { collectWhileScrolling } from "./scrollCollector.ts";
import { SessionControl } from "./SessionControl.ts";

it.effect("a blocked cut during the collector gate sends no mouse input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      vi.spyOn(page, "waitForTimeout").mockResolvedValue();
      const move = vi.spyOn(page.mouse, "move");
      const wheel = vi.spyOn(page.mouse, "wheel");
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const control = new SessionControl("agent");
      const action = control.agent("agent", (signal) =>
        collectWhileScrolling(
          page,
          control,
          Object.assign(
            async () => {
              Deferred.doneUnsafe(entered, Effect.void);
              await latch.promise;
            },
            { signal },
          ),
          { maxScrolls: 1 },
        ),
      );
      void action.catch(() => undefined);
      yield* Deferred.await(entered);
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
      expect(move).not.toHaveBeenCalled();
      expect(wheel).not.toHaveBeenCalled();
    }),
  ),
);
