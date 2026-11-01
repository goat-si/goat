import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import { testActionChannel } from "./actionChannel.testkit.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { SessionControl } from "./SessionControl.ts";

it.effect("a cut after select admission leaves the selection unchanged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      yield* Effect.promise(() =>
        page.setContent(
          '<select id="choice" onchange="window.changes++"><option value="a">a</option><option value="b">b</option></select><script>window.changes=0</script>',
        ),
      );
      const locator = page.locator("#choice");
      const handle = yield* Effect.promise(() => locator.elementHandle());
      if (!handle) throw new Error("The select is missing.");
      vi.spyOn(page, "locator").mockReturnValue(locator);
      vi.spyOn(locator, "elementHandle").mockResolvedValue(handle);
      const evaluate = vi.spyOn(handle, "evaluate");
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const waiting = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const control = new SessionControl("agent");
      const action = control.agent("agent", (signal) => {
        const delayedSignal = new Proxy(signal, {
          get(target, key) {
            if (key === "throwIfAborted")
              return () => {
                target.throwIfAborted();
                control.cutBlockedUrl();
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const gate = Object.assign(
          async () => {
            Deferred.doneUnsafe(waiting, Effect.void);
            await latch.promise;
          },
          { signal: delayedSignal, channel: testActionChannel(page, cdp, signal) },
        );
        return ServerBrowserPage.select(page, { locator: "#choice", values: ["b"] }, gate);
      });
      void action.catch(() => undefined);
      yield* Deferred.await(waiting);
      evaluate.mockClear();
      yield* Deferred.succeed(resume, undefined);
      const result = yield* Effect.promise(() =>
        action.then(
          () => null,
          (cause: unknown) => cause,
        ),
      );
      yield* Effect.promise(() => control.system(async () => {}));
      expect(result).toMatchObject({ reason: "blocked_url" });
      expect(evaluate).not.toHaveBeenCalled();
      expect(yield* Effect.promise(() => page.locator("#choice").inputValue())).toBe("a");
      expect(yield* Effect.promise(() => page.evaluate("window.changes"))).toBe(0);
    }),
  ),
);
