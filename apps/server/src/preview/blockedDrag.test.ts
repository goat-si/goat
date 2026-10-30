import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { chromium } from "playwright-core";
import { expect } from "vite-plus/test";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";
import { dragBetween } from "./pointerInput.ts";

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
      const result = yield* Effect.promise(() =>
        ServerBrowserPage.drag(page, { source: "#a", target: "#b" }, undefined, async () => {
          if (++gates === 3) await visit.promise;
          if (blocked) throw new BrowserControlInterrupted("blocked", "blocked_url");
        }).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ reason: "blocked_url" });
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

it.effect("a refusal before release does not drop on the target", () =>
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
      let gates = 0;
      const result = yield* Effect.promise(() =>
        ServerBrowserPage.drag(page, { source: "#a", target: "#b" }, undefined, () => {
          if (++gates === 13) throw new BrowserControlInterrupted("blocked", "blocked_url", false);
        }).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
      expect(result.ok).toBe(false);
      expect(yield* Effect.promise(() => page.evaluate("drops"))).toBe(0);
    }),
  ),
);

it.effect(
  "a blocked drag sends only the accepted release at its start, without keys, moves, or drop",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* Effect.acquireRelease(
          Effect.promise(() => chromium.launch({ headless: true })),
          (browser) => Effect.promise(() => browser.close()),
        );
        const page = yield* Effect.promise(() => browser.newPage());
        yield* Effect.promise(() =>
          page.setContent(
            `<div id="a" draggable="true" style="width:80px;height:80px">a</div><div id="b" style="width:80px;height:80px">b</div><script>window.events=[];for(const type of ['keydown','pointermove','pointerup','drop'])addEventListener(type,e=>events.push([type,e.clientX,e.clientY]),true);b.addEventListener('dragover',e=>e.preventDefault())</script>`,
          ),
        );
        let count = 0;
        const result = yield* Effect.promise(() =>
          ServerBrowserPage.drag(
            page,
            { from: { x: 40, y: 40 }, to: { x: 40, y: 120 }, steps: 2 },
            undefined,
            async () => {
              if (++count === 5) {
                await page.evaluate("events=[]");
                throw new BrowserControlInterrupted("blocked", "blocked_url", false);
              }
            },
          ).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatchObject({ reason: "blocked_url" });
        const events = yield* Effect.promise(() => page.evaluate("events"));
        expect(events).toEqual([["pointerup", 40, 40]]);
      }),
    ),
);

it.effect("a failed drag cancellation still sends the accepted start-point release", () =>
  Effect.gen(function* () {
    const calls: Array<{ method: string; params?: object }> = [];
    const session = {
      send: async (method: string, params?: object) => {
        calls.push({ method, params });
        if (method === "Input.cancelDragging") throw new Error("cancel failed");
        return {};
      },
      detach: async () => {},
    };
    const page = {
      context: () => ({ newCDPSession: async () => session }),
    } as unknown as import("playwright-core").Page;
    let gates = 0;
    const error = yield* Effect.promise(() =>
      dragBetween(
        page,
        { from: { x: 2, y: 3 }, to: { x: 8, y: 9 } },
        () => {
          if (++gates === 3) throw new BrowserControlInterrupted("blocked", "blocked_url", false);
        },
        Infinity,
      ).then(
        () => null,
        (cause: unknown) => cause,
      ),
    );
    expect(error).toBeInstanceOf(Error);
    expect(
      calls.filter(
        (call) =>
          call.method === "Input.dispatchMouseEvent" &&
          "type" in (call.params ?? {}) &&
          (call.params as { type: string }).type === "mouseReleased",
      ),
    ).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseReleased", x: 2, y: 3, button: "left", buttons: 0, clickCount: 1 },
      },
    ]);
  }),
);
