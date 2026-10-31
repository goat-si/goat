import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  PreviewTabId,
  type EnvironmentId,
  type PreviewAutomationClickInput,
  type PreviewAutomationScrollInput,
  type ProviderInstanceId,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeURL from "node:url";
import { chromium } from "playwright-core";
import type { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { makePreviewTargetHost } from "../screenCode/PreviewTargetHost.ts";
import { createScreenDispatchRouter } from "../screenCode/ScreenDispatchRouter.ts";
import { ScreenRunService } from "../screenCode/ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "../screenCode/ScreenRuntimeAsset.ts";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

const invocation = {
  environmentId: "env" as EnvironmentId,
  capabilities: new Set(["preview" as const]),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId: "thread" as ThreadId,
    providerSessionId: "s",
    providerInstanceId: "p" as ProviderInstanceId,
  },
  reauthorize: () => Effect.void,
};

// A canvas has no elements inside it, so only a screenshot point reaches a spot off its center.
const LAB = `<body style="margin:0;height:2000px">
  <canvas id="cv" width="200" height="100" style="position:absolute;left:40px;top:30px"></canvas>
  <script>
    window.hits = [];
    cv.addEventListener("click", (event) => hits.push([event.offsetX, event.offsetY]));
  </script>
</body>`;

it.live(
  "a cell clicks a canvas at a screenshot point off its center, and the point is stale after a scroll",
  () =>
    Effect.gen(function* () {
      expect(chromiumInstalled).toBe(true);
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() =>
          chromium.launch({ headless: true, args: ["--force-device-scale-factor=2"] }),
        ),
        (opened) => Effect.promise(() => opened.close()),
      );
      const context = yield* Effect.promise(() =>
        browser.newContext({ viewport: { width: 300, height: 200 }, deviceScaleFactor: 2 }),
      );
      const page = yield* Effect.promise(() => context.newPage());
      const cdp = yield* Effect.promise(() => context.newCDPSession(page));
      yield* Effect.promise(async () => {
        await page.route("https://lab.test/", (route) =>
          route.fulfill({ body: LAB, contentType: "text/html" }),
        );
        await page.goto("https://lab.test/");
      });
      const tab = {
        environmentId: "env",
        browserInstanceId: "server-browser",
        connectionId: "connection",
        threadId: "thread",
        tabId: PreviewTabId.make("lab"),
        title: "Lab",
        url: "https://lab.test/",
        owner: "unclaimed" as const,
        ownedByCaller: false,
        controlGeneration: 0,
      };
      // The server browser's own page calls, without its session plumbing.
      const run = (operation: string, input: unknown): Promise<unknown> => {
        if (operation === "status")
          return Promise.resolve({
            tabId: tab.tabId,
            url: page.url(),
            control: { owner: "unclaimed", generation: 0 },
          });
        if (operation === "snapshot")
          return ServerBrowserPage.snapshot({
            ...(input as { captureImage?: boolean }),
            page,
            cdp,
            renderScale: 2,
            consoleEntries: [],
            networkEntries: [],
            actionTimeline: [],
            timeoutMs: 20_000,
          });
        if (operation === "click")
          return ServerBrowserPage.click(page, input as PreviewAutomationClickInput).then(
            ({ effect, evidence }) => ({ effect, evidence, url: page.url() }),
          );
        if (operation === "scroll")
          return ServerBrowserPage.scroll(page, input as PreviewAutomationScrollInput);
        return Promise.resolve({});
      };
      const broker: Pick<PreviewAutomationBroker["Service"], "invoke" | "listBoundTabs"> = {
        listBoundTabs: () => Effect.succeed([tab]),
        invoke: <A>(request: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0]) =>
          Effect.promise(() => run(request.operation, request.input) as Promise<A>),
      };
      const tabHost = yield* makePreviewTargetHost(broker);
      const result = yield* Effect.gen(function* () {
        const service = yield* ScreenRunService;
        return yield* service.runCell({
          runId: "r",
          turnId: "t",
          threadId: "thread",
          environmentId: "env",
          invocation,
          // The canvas's (30, 20) is viewport (70, 50), which is (140, 100) in a 2x screenshot.
          source: `const tab = await screen.tab({tabId: 'lab'});
          await tab.claim();
          const shot = await tab.screenshot();
          const page = await tab.observe({ screenshot: true });
          const clicked = await tab.click([140, 100]);
          await tab.scroll(null, 'down', 1);
          let stale;
          try { await tab.click([140, 100]); } catch (error) { stale = error.code; }
          return { size: [shot.pixelWidth, shot.pixelHeight], shot: shot.imageRef, observed: page.image.imageRef, verdict: clicked.verdict, stale };`,
        });
      }).pipe(
        Effect.provide(
          ScreenRunService.layerWithRuntime({
            dispatcher: createScreenDispatchRouter({ tab: tabHost }),
            tabHost,
            invocation: {
              command: process.execPath,
              entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
            },
            assetResolver: () => resolveScreenRuntimeAsset("dev"),
          }).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      expect(result).toMatchObject({
        status: "completed",
        value: { size: [600, 400], stale: "stale_reference" },
      });
      // Both reads captured the unchanged page; the cell sends that image once and both name it.
      const { shot, observed } = result.value as { shot: string; observed: string };
      expect(observed).toBe(shot);
      expect(result.images.map((image) => image.imageRef)).toEqual([shot]);
      expect(yield* Effect.promise(() => page.evaluate("hits"))).toEqual([[30, 20]]);
    }).pipe(Effect.scoped),
);
