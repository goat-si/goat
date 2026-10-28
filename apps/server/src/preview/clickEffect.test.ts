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
const fakePage = (evaluateHandle: () => Promise<unknown>) =>
  ({
    url: () => "https://page.test/",
    on: () => undefined,
    off: () => undefined,
    mainFrame: () => undefined,
    evaluateHandle,
  }) as unknown as Page;

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
  await watch.arm({ x: 1, y: 1 });
  await expect(watch.settle()).resolves.toEqual({ effect: "suspected_noop", evidence: [] });
});

it("stops waiting for a watch that a dialog holds, and still answers", async () => {
  const watch = await watchClick(fakePage(() => new Promise(() => undefined)));
  await watch.arm({ x: 1, y: 1 });
  await expect(watch.settle()).resolves.toEqual({ effect: "suspected_noop", evidence: [] });
});
