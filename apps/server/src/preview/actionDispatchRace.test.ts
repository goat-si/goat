import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { SessionControl } from "./SessionControl.ts";

it.effect("a blocked cut while the evaluation gate waits sends no expression", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const sent = vi.spyOn(cdp, "send");
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const control = new SessionControl("agent");
      const action = control.agent("agent", (signal) =>
        ServerBrowserPage.evaluate(
          { page, cdp },
          { expression: "globalThis.__late = true" },
          5000,
          Object.assign(
            async () => {
              Deferred.doneUnsafe(entered, Effect.void);
              await latch.promise;
            },
            { signal },
          ),
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
      expect(sent.mock.calls.filter(([method]) => method === "Runtime.evaluate")).toHaveLength(0);
      expect(result).toMatchObject({ reason: "blocked_url" });
      expect(yield* Effect.promise(() => page.evaluate("globalThis.__late"))).toBeUndefined();
    }),
  ),
);
