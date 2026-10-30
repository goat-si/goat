import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { chromium, type ElementHandle } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import { makeBlockedTabFence } from "./blockedTabFence.ts";
import { inputFence } from "./PreviewInputFence.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { SessionControl } from "./SessionControl.ts";
import { waitUntilWritable } from "./actionReadiness.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

const externalFence = () => new AbortController();

it.effect("a fence immediately after readiness admission prevents starting scroll", () =>
  Effect.gen(function* () {
    const scroll = vi.fn(async () => {});
    const handle = {
      isVisible: async () => true,
      isEditable: async () => true,
      ownerFrame: async () => null,
      scrollIntoViewIfNeeded: scroll,
    } as unknown as ElementHandle;
    const controller = externalFence();
    const gate = Object.assign(
      () => {
        controller.abort(new BrowserControlInterrupted("blocked", "blocked_url"));
      },
      { signal: controller.signal },
    );
    const error = yield* Effect.promise(() =>
      waitUntilWritable(handle, Infinity, {}, gate).then(
        () => null,
        (cause: unknown) => cause,
      ),
    );
    expect(error).toMatchObject({ reason: "blocked_url" });
    expect(scroll).not.toHaveBeenCalled();
  }),
);

it.effect("a fence during readiness prevents scrolling, focus, selection and typing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      yield* Effect.promise(() =>
        page.setContent(
          `<style>body{height:3000px}input{position:absolute;top:2000px}</style><input id="f" disabled value="old"><script>window.counts={scroll:0,focus:0,select:0};addEventListener('scroll',()=>counts.scroll++);f.addEventListener('focus',()=>counts.focus++);f.addEventListener('select',()=>counts.select++);</script>`,
        ),
      );
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const control = new SessionControl("agent");
      control.onDispatchCut(inputFence(cdp));
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ blockedBrowserHosts: ["blocked.test"] });
      const threadId = ThreadId.make("readiness-fence");
      const end = yield* activity.begin(threadId, "run");
      const fence = yield* makeBlockedTabFence();
      const waiting = yield* Deferred.make<void>();
      const tab = { threadId, tabId: "tab", closing: false, page, control };
      const action = control.agent("agent", (signal) =>
        ServerBrowserPage.type(
          page,
          { locator: "#f", text: "x", clear: true },
          Object.assign(fence.gate(tab, "run", control.dispatchGate()), { signal }),
          {
            onWaiting: () => {
              Deferred.doneUnsafe(waiting, Effect.void);
            },
          },
        ),
      );
      void action.catch(() => undefined);
      yield* Deferred.await(waiting);
      yield* Effect.promise(() => fence.observe(tab, "https://blocked.test/")!);
      const result = yield* Effect.promise(() =>
        action.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
      yield* Effect.promise(() => control.system(async () => {}));
      yield* Effect.promise(() => page.evaluate("f.disabled=false"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ reason: "blocked_url" });
      expect(
        yield* Effect.promise(() =>
          page.evaluate("[counts.scroll,counts.focus,counts.select,window.scrollY,f.value]"),
        ),
      ).toEqual([0, 0, 0, 0, "old"]);
      yield* end;
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(PreviewAgentActivity.layer, ServerSettings.layerTest()).pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "goat-readiness-fence-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("a fence immediately after the focus gate sends no focus", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      yield* Effect.promise(() =>
        page.setContent(
          `<input id="f" value="old"><script>window.focuses=0;f.addEventListener('focus',()=>focuses++)</script>`,
        ),
      );
      const controller = externalFence();
      let calls = 0;
      const gate = Object.assign(
        () => {
          if (++calls === 2)
            controller.abort(new BrowserControlInterrupted("blocked", "blocked_url"));
        },
        { signal: controller.signal },
      );
      const result = yield* Effect.promise(() =>
        ServerBrowserPage.type(page, { locator: "#f", text: "x", clear: true }, gate).then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(result).toMatchObject({ reason: "blocked_url" });
      expect(yield* Effect.promise(() => page.evaluate("focuses"))).toBe(0);
    }),
  ),
);

it.effect("a fence immediately after the selection gate sends no selection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      yield* Effect.promise(() =>
        page.setContent(
          `<input id="f" value="old"><script>window.selections=0;const original=f.select.bind(f);f.select=()=>{selections++;original()}</script>`,
        ),
      );
      const controller = externalFence();
      let calls = 0;
      const gate = Object.assign(
        () => {
          if (++calls === 3)
            controller.abort(new BrowserControlInterrupted("blocked", "blocked_url"));
        },
        { signal: controller.signal },
      );
      const result = yield* Effect.promise(() =>
        ServerBrowserPage.type(page, { locator: "#f", text: "x", clear: true }, gate).then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(result).toMatchObject({ reason: "blocked_url" });
      expect(yield* Effect.promise(() => page.evaluate("selections"))).toBe(0);
    }),
  ),
);
