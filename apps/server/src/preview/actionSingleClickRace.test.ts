import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import { testActionChannel } from "./actionChannel.testkit.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { SessionControl } from "./SessionControl.ts";

it.effect("a cut after single-click admission sends no click", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      yield* Effect.promise(() =>
        page.setContent(
          '<button onclick="window.clicks++">click</button><script>window.clicks=0</script>',
        ),
      );
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const clicked = vi.spyOn(page.mouse, "click");
      const waiting = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const control = new SessionControl("agent");
      let calls = 0;
      let cut = false;
      const action = control.agent("agent", (signal) => {
        const delayedSignal = new Proxy(signal, {
          get(target, key) {
            if (key === "throwIfAborted")
              return () => {
                target.throwIfAborted();
                if (cut) control.cutBlockedUrl();
              };
            return Reflect.get(target, key, target);
          },
        });
        const gate = Object.assign(
          async () => {
            if (++calls === 3) {
              Deferred.doneUnsafe(waiting, Effect.void);
              await latch.promise;
              cut = true;
            }
          },
          { signal: delayedSignal, channel: testActionChannel(page, cdp, signal) },
        );
        return ServerBrowserPage.click(page, { x: 20, y: 15 }, undefined, gate);
      });
      void action.catch(() => undefined);
      yield* Deferred.await(waiting);
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Effect.promise(() =>
        action.then(
          () => null,
          (cause: unknown) => cause,
        ),
      );
      yield* Effect.promise(() => control.system(async () => {}));
      expect(result).toMatchObject({ reason: "blocked_url" });
      expect(clicked).not.toHaveBeenCalled();
      expect(yield* Effect.promise(() => page.evaluate("window.clicks"))).toBe(0);
    }),
  ),
);
