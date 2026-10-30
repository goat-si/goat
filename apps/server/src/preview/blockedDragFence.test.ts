import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { chromium } from "playwright-core";
import { expect } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import { makeBlockedTabFence } from "./blockedTabFence.ts";
import { inputFence } from "./PreviewInputFence.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { SessionControl } from "./SessionControl.ts";

it.effect("a newly blocked host cuts a drag with only its accepted start-point release", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      yield* Effect.promise(() =>
        page.route("https://blocked.test/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<div id="a" draggable="true" style="width:80px;height:80px">a</div><div id="b" style="width:80px;height:80px">b</div><script>window.events=[];for(const type of ['keydown','pointermove','pointerup','drop'])addEventListener(type,e=>events.push([type,e.clientX,e.clientY]),true);b.addEventListener('dragover',e=>e.preventDefault())</script>`,
          }),
        ),
      );
      yield* Effect.promise(() => page.goto("https://blocked.test/"));
      const cdp = yield* Effect.promise(() => page.context().newCDPSession(page));
      const control = new SessionControl("agent");
      control.onDispatchCut(inputFence(cdp));
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      const settings = yield* ServerSettings.ServerSettingsService;
      const threadId = ThreadId.make("drag-fence");
      const end = yield* activity.begin(threadId, "run");
      const fence = yield* makeBlockedTabFence();
      const reached = yield* Deferred.make<void>();
      const resume = Promise.withResolvers<void>();
      const tab = { threadId, tabId: "tab", closing: false, page, control };
      const action = control.agent("agent", () => {
        const base = fence.gate(tab, "run", control.dispatchGate());
        let calls = 0;
        return ServerBrowserPage.drag(
          page,
          { from: { x: 40, y: 40 }, to: { x: 40, y: 120 }, steps: 2 },
          undefined,
          async () => {
            if (++calls === 5) {
              Deferred.doneUnsafe(reached, Effect.void);
              await resume.promise;
            }
            await base();
          },
        );
      });
      void action.catch(() => undefined);
      yield* Deferred.await(reached);
      yield* Effect.promise(() => page.evaluate("events=[]"));
      yield* settings.updateSettings({ blockedBrowserHosts: ["blocked.test"] });
      resume.resolve();
      const result = yield* Effect.promise(() =>
        action.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
      yield* Effect.promise(() => control.system(async () => {}));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ reason: "blocked_url" });
      const events = yield* Effect.promise(() => page.evaluate("events"));
      expect(events).not.toContainEqual(expect.arrayContaining(["pointermove"]));
      expect(events).not.toContainEqual(expect.arrayContaining(["keydown"]));
      expect(events).not.toContainEqual(expect.arrayContaining(["drop"]));
      yield* end;
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(PreviewAgentActivity.layer, ServerSettings.layerTest()).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-drag-fence-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
