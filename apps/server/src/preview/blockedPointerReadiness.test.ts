import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { chromium } from "playwright-core";
import { expect, vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import { makeBlockedTabFence } from "./blockedTabFence.ts";
import { inputFence } from "./PreviewInputFence.ts";
import { testActionChannel } from "./actionChannel.testkit.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { SessionControl } from "./SessionControl.ts";

const pointerPreparation = (operation: "click" | "hover" | "drag") =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      yield* Effect.promise(() =>
        page.setContent(
          '<style>body{height:3000px}#late{position:absolute;top:2000px}</style><button id="end">end</button>',
        ),
      );
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ blockedBrowserHosts: ["blocked.test"] });
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const threadId = ThreadId.make("pointer-readiness");
      const end = yield* activity.begin(threadId, "run");
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const control = new SessionControl("agent");
      control.onDispatchCut(inputFence(cdp));
      const fence = yield* makeBlockedTabFence();
      const waiting = yield* Deferred.make<void>();
      const original = page.locator.bind(page);
      vi.spyOn(page, "locator").mockImplementation((selector, options) => {
        if (selector === "#late") Deferred.doneUnsafe(waiting, Effect.void);
        return original(selector, options);
      });
      const tab = { threadId, tabId: "tab", closing: false, page, control };
      const fenced = yield* Deferred.make<void>();
      yield* Effect.promise(() =>
        page.route("https://blocked.test/**", (route) => route.fulfill({ body: "blocked" })),
      );
      page.on("framenavigated", (frame) => {
        const observed = fence.observe(tab, frame.url());
        if (observed) void observed.then(() => Deferred.doneUnsafe(fenced, Effect.void));
      });
      const action = control.agent("agent", async (signal) => {
        const gate = Object.assign(fence.gate(tab, "run", control.dispatchGate()), { signal });
        if (operation === "click")
          return void (await ServerBrowserPage.click(page, { locator: "#late" }, undefined, gate));
        if (operation === "hover")
          return void (await ServerBrowserPage.hover(page, { locator: "#late" }, undefined, gate));
        await ServerBrowserPage.drag(page, { source: "#late", target: "#end" }, undefined, gate);
      });
      void action.catch(() => undefined);
      yield* Deferred.await(waiting);
      yield* Effect.promise(() =>
        page.evaluate(
          "document.body.insertAdjacentHTML('beforeend', '<iframe src=\"https://blocked.test/\"></iframe>')",
        ),
      );
      yield* Deferred.await(fenced);
      const result = yield* Effect.promise(() =>
        action.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
      yield* Effect.promise(() => control.system(async () => {}));
      yield* Effect.promise(() =>
        page.evaluate(
          "document.body.insertAdjacentHTML('beforeend','<button id=late>late</button>')",
        ),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ reason: "blocked_url" });
      expect(yield* Effect.promise(() => page.evaluate("scrollY"))).toBe(0);
      yield* end;
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(PreviewAgentActivity.layer, ServerSettings.layerTest()).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-pointer-prep-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

it.effect("a fenced click waiting for a target never scrolls when it appears", () =>
  pointerPreparation("click"),
);
it.effect("a fenced hover waiting for a target never scrolls when it appears", () =>
  pointerPreparation("hover"),
);
it.effect("a fenced locator drag waiting for a source never scrolls when it appears", () =>
  pointerPreparation("drag"),
);

it.effect(
  "an upload refused at its preparation gate does not expose a file target on the page",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* Effect.acquireRelease(
          Effect.promise(() => chromium.launch({ headless: true })),
          (browser) => Effect.promise(() => browser.close()),
        );
        const page = yield* Effect.promise(() => browser.newPage());
        yield* Effect.promise(() => page.setContent('<input id="file" type="file">'));
        const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
        const handle = yield* Effect.promise(() => page.locator("#file").elementHandle());
        if (!handle) throw new Error("missing file input");
        let exposed = -1;
        const { uploadInto } = yield* Effect.promise(() => import("./PreviewUpload.ts"));
        const error = yield* Effect.promise(() =>
          uploadInto(
            cdp,
            handle,
            [],
            Object.assign(
              async () => {
                exposed = await page.evaluate(
                  "Object.keys(globalThis).filter(k => k.startsWith('__goatUploadTarget_')).length",
                );
                throw new Error("fenced");
              },
              { channel: testActionChannel(page, cdp) },
            ),
          ).then(
            () => undefined,
            (cause: unknown) => cause,
          ),
        );
        expect(error).toEqual(new Error("fenced"));
        expect(exposed).toBe(0);
      }),
    ),
);
