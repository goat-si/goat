import { chromium, type Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

const fixture = async (run: (page: Page) => Promise<void>) => {
  expect(chromiumInstalled).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.route("https://app.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>app</p>" }),
    );
    await page.goto("https://app.test/start");
    await run(page);
  } finally {
    await browser.close();
  }
};

it("a URL glob wait holds once a same-document change reaches a matching URL", () =>
  fixture(async (page) => {
    const waiting = ServerBrowserPage.waitFor(page, { urlGlob: "**/done*" }).then(() => page.url());
    await page.evaluate("history.pushState({}, '', '/flow/done?step=3')");
    expect(await waiting).toBe("https://app.test/flow/done?step=3");
  }));

it("a URL glob wait on a URL that already matches holds at once, beside other conditions", () =>
  fixture(async (page) => {
    await expect(
      ServerBrowserPage.waitFor(page, { urlGlob: "https://app.test/*", text: "app" }),
    ).resolves.toEqual({});
  }));
