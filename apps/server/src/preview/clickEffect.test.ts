import { chromium, type Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { watchClick } from "./clickEffect.ts";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

const fixture = async (run: (page: Page) => Promise<void>) => {
  expect(chromiumInstalled).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    await run(await (await browser.newContext()).newPage());
  } finally {
    await browser.close();
  }
};

/** A page whose script reads never answer or always fail, as a dialog or a crashed renderer. */
const fakePage = (
  evaluateHandle: () => Promise<unknown>,
  url = { current: "https://page.test/" },
) => {
  const frame = { evaluateHandle };
  return {
    url: () => url.current,
    on: () => undefined,
    off: () => undefined,
    mainFrame: () => frame,
    evaluateHandle,
  } as unknown as Page;
};

it("does not confirm a click on inert content while the page ticks and polls", () =>
  fixture(async (page) => {
    await page.route("https://poll.test/**", (route) => route.fulfill({ body: "{}" }));
    await page.setContent(
      `<p id="still">static</p><span id="clock"></span><script>
        setInterval(() => { clock.textContent = String(Date.now()); fetch("https://poll.test/x").catch(() => {}); }, 5);
      </script>`,
    );
    await expect(ServerBrowserPage.click(page, { selector: "#still" })).resolves.toMatchObject({
      effect: "suspected_noop",
      evidence: [],
    });
  }));

it("does not count a failed page read as a navigation", async () => {
  const handle = {
    evaluate: async () => Promise.reject(new Error("Target crashed")),
    dispose: async () => undefined,
  };
  const watch = await watchClick(fakePage(async () => handle));
  await watch.arm({ point: { x: 1, y: 1 } });
  await expect(watch.settle()).resolves.toEqual({ effect: "suspected_noop", evidence: [] });
});

it("stops waiting for a watch that a dialog holds, and still answers", async () => {
  const watch = await watchClick(fakePage(() => new Promise(() => undefined)));
  await watch.arm({ point: { x: 1, y: 1 } });
  await expect(watch.settle()).resolves.toEqual({ effect: "suspected_noop", evidence: [] });
});

it("does not count a URL change from before the click was armed", async () => {
  const url = { current: "https://page.test/" };
  const watch = await watchClick(fakePage(async () => Promise.reject(new Error("no script")), url));
  url.current = "https://page.test/#route";
  await watch.arm({ point: { x: 1, y: 1 } });
  await expect(watch.settle()).resolves.toEqual({ effect: "suspected_noop", evidence: [] });
});

it("stops a watch that installed after the click stopped waiting for it", async () => {
  const late = Promise.withResolvers<unknown>();
  const stopped = Promise.withResolvers<void>();
  const watch = await watchClick(fakePage(() => late.promise));
  await watch.arm({ point: { x: 1, y: 1 } });
  await watch.settle();
  late.resolve({
    evaluate: async () => stopped.resolve(),
    dispose: async () => undefined,
  });
  await stopped.promise;
});

it("sees what a click changes inside an iframe, by locator and by point", () =>
  fixture(async (page) => {
    await page.setContent(
      `<iframe style="position:absolute;left:40px;top:40px;width:300px;height:200px;border:0" srcdoc="<button id=b onclick=&quot;this.textContent='saved'&quot; style='position:absolute;left:10px;top:10px'>save</button>"></iframe>`,
    );
    const button = page.frameLocator("iframe").locator("#b");
    await button.waitFor();
    await expect(
      ServerBrowserPage.click(page, { selector: "iframe >> internal:control=enter-frame >> #b" }),
    ).resolves.toMatchObject({ effect: "confirmed", evidence: expect.arrayContaining(["dom"]) });
    const box = (await button.boundingBox())!;
    await expect(
      ServerBrowserPage.click(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }),
    ).resolves.toMatchObject({ effect: "confirmed", evidence: expect.arrayContaining(["dom"]) });
  }));
