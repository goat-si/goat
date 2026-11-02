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
import { type CDPSession, chromium, type Page } from "playwright-core";
import type { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { makePreviewTargetHost } from "../screenCode/PreviewTargetHost.ts";
import { createScreenDispatchRouter } from "../screenCode/ScreenDispatchRouter.ts";
import { ScreenRunService } from "../screenCode/ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "../screenCode/ScreenRuntimeAsset.ts";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import { testActionPage as ServerBrowserPage } from "./actionChannel.testkit.ts";

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

const launch = async () => {
  expect(chromiumInstalled).toBe(true);
  const browser = await chromium.launch({ headless: true });
  const page = await (
    await browser.newContext({ viewport: { width: 800, height: 600 } })
  ).newPage();
  return { browser, page };
};

const snapshotTree = async (page: Page, cdp: CDPSession) =>
  String(
    (
      await ServerBrowserPage.snapshot({
        page,
        cdp,
        renderScale: 1,
        captureImage: false,
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
        timeoutMs: 15_000,
      })
    ).accessibilityTree,
  );
const lineOf = (tree: string, name: string) =>
  tree.split("\n").find((line) => line.includes(`button "${name}"`)) ?? `no "${name}" in ${tree}`;

// Every cover but the first is one paint order alone cannot prove solid, so only Buy is marked.
const COVERS = `<body style="margin:0">
  <button style="position:absolute;left:10px;top:10px">Buy</button>
  <div style="position:fixed;left:0;top:0;width:200px;height:60px;background:#fff"></div>
  <button style="position:absolute;left:300px;top:10px">Free</button>
  <div style="position:absolute;left:10px;top:100px;max-height:0;overflow:hidden">
    <div style="width:300px;height:100px;background:#fff"></div>
  </div>
  <button style="position:absolute;left:10px;top:120px">Below accordion</button>
  <div style="position:absolute;left:10px;top:250px;width:120px;height:120px;border-radius:50%;overflow:hidden;z-index:1">
    <div style="width:120px;height:120px;background:#fff"></div>
  </div>
  <button style="position:absolute;left:10px;top:250px">Under round clip</button>
  <div style="position:absolute;left:300px;top:100px;opacity:0.5;z-index:1">
    <div style="width:200px;height:60px;background:#fff"></div>
  </div>
  <button style="position:absolute;left:300px;top:110px">Under translucent</button>
  <button style="position:absolute;left:300px;top:250px;width:80px;height:30px;padding:0;border:0">
    <span style="display:block;width:120px;height:50px;background:#fff">Own child</span>
  </button>
  <div style="position:absolute;left:10px;top:400px;width:200px;font:16px/30px monospace">
    <span style="position:relative;z-index:1;background:#fff">xxxxxxxxxxxxxxxxxxxx xxxxx</span>
  </div>
  <button style="position:absolute;left:110px;top:435px;width:60px;height:15px;padding:0;font-size:8px">Beside inline</button>
</body>`;

// The body's overflow clips here, since the root's is not visible; its cover cannot reach the button.
const BODY_CLIP = `<html style="overflow:hidden"><body style="margin:0;position:absolute;width:50px;height:50px;overflow:hidden">
  <div style="position:relative;z-index:2;width:200px;height:100px;background:#fff"></div>
  <button style="position:fixed;z-index:1;left:100px;top:20px">Outside body</button>
</body></html>`;

it("a snapshot marks only a button under a solid later-painted cover [occluded], and none without paint data", async () => {
  const { browser, page } = await launch();
  try {
    await page.setContent(COVERS);
    const cdp = await page.context().newCDPSession(page);
    const tree = await snapshotTree(page, cdp);
    expect(lineOf(tree, "Buy")).toContain("[occluded]");
    for (const name of [
      "Free",
      "Below accordion",
      "Under round clip",
      "Under translucent",
      "Beside inline",
    ])
      expect(lineOf(tree, name)).not.toContain("[occluded]");
    expect(tree.match(/\[occluded\]/g)).toHaveLength(1);
    await page.setContent(BODY_CLIP);
    expect(lineOf(await snapshotTree(page, cdp), "Outside body")).not.toContain("[occluded]");
    const noPaint = {
      send: (method: string, params?: object) =>
        method === "DOMSnapshot.captureSnapshot"
          ? Promise.reject(new Error("unsupported"))
          : cdp.send(method as "Runtime.evaluate", params as never),
    } as unknown as CDPSession;
    expect(await snapshotTree(page, noPaint)).not.toContain("[occluded]");
  } finally {
    await browser.close();
  }
});

it("a ref click lands in the largest fragment of a wrapped link, and inside a frame's visible part", async () => {
  const { browser, page } = await launch();
  try {
    // The link's first fragment is one short word at the end of the first line.
    await page.setContent(`<p style="width:200px;font:16px/20px monospace;margin:0">xxxxxxxxxxxxxxxx
      <a id="link" href="#">ab cdefghijklmnop qrstuvwxyz</a></p>
      <iframe style="position:absolute;left:300px;top:0;width:200px;height:100px;border:10px solid #000;padding:5px"
        srcdoc='<html style="overflow:clip"><body style="margin:0"><button id="half" style="position:absolute;left:150px;top:10px;width:100px;height:30px">Half</button></body></html>'></iframe>
      <script>
        link.addEventListener("click", (event) => {
          event.preventDefault();
          const rects = [...link.getClientRects()];
          const areas = rects.map((rect) => rect.width * rect.height);
          window.landed = { fragments: rects.length, largest: areas.indexOf(Math.max(...areas)),
            at: rects.findIndex((rect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) };
        });
      </script>`);
    const frame = page.frameLocator("iframe");
    await frame.locator("#half").evaluate((button) => {
      button.addEventListener("click", (event: { readonly clientX: number }) => {
        (globalThis as { clickedAt?: number }).clickedAt = event.clientX;
      });
    });
    await ServerBrowserPage.click(page, { locator: "#link" });
    // Playwright alone clicks the first fragment; the click lands in the largest one instead.
    const landed = (await page.evaluate("window.landed")) as Record<string, number>;
    expect(landed.fragments).toBeGreaterThan(1);
    expect(landed.largest).toBeGreaterThan(0);
    expect(landed.at).toBe(landed.largest);
    await ServerBrowserPage.click(page, {
      locator: "iframe >> internal:control=enter-frame >> #half",
    });
    // The frame shows x 0..200 of its document; the button spans 150..250, so its visible centre is 175.
    expect(
      await frame.locator("body").evaluate(() => (globalThis as { clickedAt?: number }).clickedAt),
    ).toBe(175);
  } finally {
    await browser.close();
  }
});

it("a ref click on a covered target refuses before input, naming the cover, and nothing receives a click", async () => {
  const { browser, page } = await launch();
  try {
    await page.setContent(`<button id="b">Save</button>
      <div id="consent" role="dialog" style="position:fixed;inset:0;background:#fff"></div>
      <script>window.clicks = []; addEventListener("pointerdown", (event) => clicks.push(event.target.id), true);</script>`);
    await expect(ServerBrowserPage.click(page, { locator: "#b" })).rejects.toMatchObject({
      tag: "PreviewAutomationExecutionError",
      detail: {
        beforeInput: true,
        kind: "occluded_refused",
        interceptedBy: "Now at the target: <div> (dialog) #consent.",
      },
    });
    expect(await page.evaluate("window.clicks")).toEqual([]);
  } finally {
    await browser.close();
  }
});

it("a ref click reaches a shadow button through the light-DOM text slotted into it", async () => {
  const { browser, page } = await launch();
  try {
    await page.setContent(`<x-host><span>Slotted label</span></x-host>
      <script>
        window.pressed = false;
        const root = document.querySelector("x-host").attachShadow({ mode: "open" });
        root.innerHTML = '<button style="font-size:24px"><slot></slot></button>';
        root.querySelector("button").addEventListener("click", () => (window.pressed = true));
      </script>`);
    await ServerBrowserPage.click(page, { locator: "x-host >> internal:role=button" });
    expect(await page.evaluate("window.pressed")).toBe(true);
  } finally {
    await browser.close();
  }
});
