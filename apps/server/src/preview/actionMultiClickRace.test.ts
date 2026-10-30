import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import { testActionPage as ServerBrowserPage } from "./actionChannel.testkit.ts";
import { testActionChannel } from "./actionChannel.testkit.ts";
import { SessionControl } from "./SessionControl.ts";

it.effect("a cut during the second press prevents an ungated mouse-up", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      yield* Effect.promise(() =>
        page.setContent('<button style="width:200px;height:200px">click</button>'),
      );
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const sent = vi.spyOn(cdp, "send");
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const latch = Promise.withResolvers<void>();
      yield* Effect.forkChild(
        Deferred.await(resume).pipe(Effect.tap(() => Effect.sync(latch.resolve))),
      );
      const down = page.mouse.down.bind(page.mouse);
      vi.spyOn(page.mouse, "down").mockImplementation(async (options) => {
        await down(options);
        Deferred.doneUnsafe(entered, Effect.void);
        await latch.promise;
      });
      const up = vi.spyOn(page.mouse, "up");
      const control = new SessionControl("agent");
      const action = control.agent("agent", (signal) =>
        ServerBrowserPage.click(
          page,
          { x: 20, y: 20, clickCount: 2 },
          undefined,
          Object.assign(control.dispatchGate(), {
            signal,
            channel: testActionChannel(page, cdp, signal),
          }),
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
      expect(up).not.toHaveBeenCalled();
      expect(sent.mock.calls[0]?.[0]).toBe("Input.cancelDragging");
      expect(sent.mock.calls.filter(([method]) => method === "Input.dispatchMouseEvent")).toEqual([
        [
          "Input.dispatchMouseEvent",
          { type: "mouseReleased", x: 20, y: 20, button: "left", buttons: 0, clickCount: 1 },
        ],
      ]);
    }),
  ),
);
