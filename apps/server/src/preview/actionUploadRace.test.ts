import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import * as PreviewUpload from "./PreviewUpload.ts";
import { SessionControl } from "./SessionControl.ts";

it.effect("a blocked cut after upload preparation starts no further browser commands", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      yield* Effect.promise(() => page.setContent('<input id="file" type="file">'));
      const handle = yield* Effect.promise(() => page.locator("#file").elementHandle());
      if (!handle) throw new Error("missing file input");
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const sent = vi.spyOn(cdp, "send");
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      let evaluations = 0;
      const delayed = new Proxy(handle, {
        get(target, property, receiver) {
          if (property !== "evaluate") return Reflect.get(target, property, receiver);
          return async (...args: Parameters<typeof handle.evaluate>) => {
            evaluations++;
            const value = await Reflect.apply(target.evaluate, target, args);
            if (evaluations === 1) {
              Deferred.doneUnsafe(entered, Effect.void);
              await latch.promise;
            }
            return value;
          };
        },
      });
      const control = new SessionControl("agent");
      const action = control.agent("agent", (signal) =>
        PreviewUpload.uploadInto(
          cdp,
          delayed,
          [],
          Object.assign(() => {}, { signal }),
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
      expect(sent.mock.calls).toHaveLength(0);
      expect(evaluations).toBe(1);
    }),
  ),
);
