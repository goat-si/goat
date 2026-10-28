import { chromium } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

const refOf = (tree: unknown, name: string) => {
  const line = String(tree)
    .split("\n")
    .find((entry) => entry.includes(`button "${name}"`));
  const ref = /\[ref=([^\]]+)\]/.exec(line ?? "")?.[1];
  expect(ref, `no ref for "${name}" in:\n${String(tree)}`).toBeDefined();
  return `aria-ref=${ref}`;
};

it("lists a cross-origin frame's controls and one far below the fold, each clickable by ref", async () => {
  expect(chromiumInstalled).toBe(true);
  const browser = await chromium.launch({ headless: true, args: ["--site-per-process"] });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.route("https://parent.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<title>Parent page</title><iframe src="https://child.test/"></iframe><div style="height:3000px"></div><button onclick="window.far = true">Far below</button>',
      }),
    );
    await page.route("https://child.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<button onclick="window.inside = true">Inside frame</button>',
      }),
    );
    await page.goto("https://parent.test/");
    const child = page.frameLocator("iframe");
    await child.getByRole("button").waitFor();
    const snapshot = await ServerBrowserPage.snapshot({
      page,
      cdp: await page.context().newCDPSession(page),
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      timeoutMs: 15_000,
    });
    expect(snapshot).toMatchObject({ url: "https://parent.test/", title: "Parent page" });
    await ServerBrowserPage.click(page, {
      locator: refOf(snapshot.accessibilityTree, "Far below"),
    });
    await ServerBrowserPage.click(page, {
      locator: refOf(snapshot.accessibilityTree, "Inside frame"),
    });
    expect(await page.evaluate("window.far")).toBe(true);
    expect(
      await child.locator("body").evaluate(() => (globalThis as { inside?: boolean }).inside),
    ).toBe(true);
  } finally {
    await browser.close();
  }
});

it("names what covers a click target, in its own document or a parent one, without page text", async () => {
  expect(chromiumInstalled).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    const cover = (id: string) =>
      `<div id="${id}" role="dialog" style="position:fixed;inset:0;background:#fff8">Private note 4242</div>`;
    await page.setContent(`<button id="b">Save</button>${cover("consent")}`);
    await expect(
      ServerBrowserPage.click(page, { locator: "#b", timeoutMs: 5_000 }),
    ).rejects.toMatchObject({
      detail: {
        interceptedBy: expect.stringContaining("Now at the target: <div> (dialog) #consent."),
      },
    });
    // A token-like id is left out, and page text never appears.
    await page.setContent(`<button id="b">Save</button>${cover("a1b2c3d4e5f6a7b8c9d0e1f2a3b4")}`);
    const tokenLike = await ServerBrowserPage.click(page, { locator: "#b", timeoutMs: 5_000 }).then(
      () => undefined,
      (error: unknown) =>
        (error as { readonly detail?: { readonly interceptedBy?: string } }).detail,
    );
    expect(tokenLike?.interceptedBy).toContain("Now at the target: <div> (dialog).");
    expect(JSON.stringify(tokenLike)).not.toMatch(/a1b2c3|4242|Private/);
    // A cover in the parent document over a frame's button is the one named.
    await page.setContent(
      `<iframe srcdoc="<button>Inner</button>"></iframe>${cover("over-frame")}`,
    );
    await page.frameLocator("iframe").getByRole("button").waitFor();
    await expect(
      ServerBrowserPage.click(page, {
        locator: "iframe >> internal:control=enter-frame >> button",
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      detail: { interceptedBy: expect.stringContaining("#over-frame") },
    });
  } finally {
    await browser.close();
  }
});
