import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";
import { expect } from "vite-plus/test";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

it.effect("a blocked visit during a locator drag prevents the drop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      const visit = Promise.withResolvers<void>();
      let blocked = false;
      let gates = 0;
      let drops = 0;
      yield* Effect.promise(() =>
        page.exposeFunction("reportDrop", () => {
          drops++;
        }),
      );
      yield* Effect.promise(() =>
        page.context().route("https://blocked.test/**", async (route) => {
          blocked = true;
          visit.resolve();
          await route.abort();
        }),
      );
      yield* Effect.promise(() =>
        page.setContent(
          `<div id="a" draggable="true" style="width:80px;height:80px">a</div><div id="b" style="width:80px;height:80px">b</div><script>a.addEventListener('mousedown',()=>location.href='https://blocked.test/');b.addEventListener('dragover',e=>e.preventDefault());b.addEventListener('drop',e=>{e.preventDefault();reportDrop()})</script>`,
        ),
      );
      const result = yield* Effect.tryPromise({
        try: () =>
          ServerBrowserPage.drag(page, { source: "#a", target: "#b" }, undefined, async () => {
            if (++gates === 3) await visit.promise;
            if (blocked) throw new BrowserControlInterrupted("blocked", "blocked_url");
          }),
        catch: (error) => error,
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ reason: "blocked_url" });
      expect(drops).toBe(0);
    }),
  ),
);

it.effect("a locator drag still delivers a normal drop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      yield* Effect.promise(() =>
        page.setContent(
          `<div id="a" draggable="true" style="width:80px;height:80px">a</div><div id="b" style="width:80px;height:80px">b</div><script>window.drops=0;b.addEventListener('dragover',e=>e.preventDefault());b.addEventListener('drop',e=>{e.preventDefault();drops++})</script>`,
        ),
      );
      yield* Effect.promise(() => ServerBrowserPage.drag(page, { source: "#a", target: "#b" }));
      expect(yield* Effect.promise(() => page.evaluate("drops"))).toBe(1);
    }),
  ),
);
