import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import { testActionChannel } from "./actionChannel.testkit.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { SessionControl } from "./SessionControl.ts";

it.effect("a cut after keyboard admission sends no keystroke", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      yield* Effect.promise(() =>
        page.setContent(
          '<script>window.keys=[];addEventListener("keydown",e=>keys.push(e.key))</script>',
        ),
      );
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const pressed = vi.spyOn(page.keyboard, "press");
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
            return Reflect.get(target, key, target);
          },
        });
        const gate = Object.assign(
          async () => {
            Deferred.doneUnsafe(waiting, Effect.void);
            await latch.promise;
          },
          { signal: delayedSignal, channel: testActionChannel(page, cdp, signal) },
        );
        return ServerBrowserPage.press(page, { key: "a" }, gate);
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
      expect(pressed).not.toHaveBeenCalled();
      expect(yield* Effect.promise(() => page.evaluate("keys"))).toEqual([]);
    }),
  ),
);
