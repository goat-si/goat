import { chromium, type CDPSession, type Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { pointBefore } from "./ServerBrowserPointer.ts";

const fixture = async (run: (page: Page, cdp: CDPSession) => Promise<void>) => {
  expect(chromiumInstalled).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await run(page, await context.newCDPSession(page));
  } finally {
    await browser.close();
  }
};

const snapshot = (page: Page, cdp: CDPSession, interactiveOnly?: boolean) =>
  ServerBrowserPage.snapshot({
    page,
    cdp,
    renderScale: 1,
    ...(interactiveOnly ? { interactiveOnly } : {}),
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
    timeoutMs: 15_000,
  });

/** The bare ref the tree shows for a button, as an agent copies it. */
const bareRef = async (page: Page, cdp: CDPSession, name: string) => {
  const line = String((await snapshot(page, cdp)).accessibilityTree)
    .split("\n")
    .find((each) => each.includes(`button "${name}"`));
  const ref = /\[ref=([^\]]+)\]/.exec(line ?? "")?.[1];
  expect(ref).toBeDefined();
  return ref!;
};

it("clicks a snapshot ref passed as the bare locator, the form the tree shows", () =>
  fixture(async (page, cdp) => {
    await page.setContent(`<button onclick="this.textContent='saved'">save</button>`);
    await ServerBrowserPage.click(page, { locator: await bareRef(page, cdp, "save") });
    expect(await page.locator("button").textContent()).toBe("saved");
  }));

it("still reads a CSS selector that merely starts like a ref", () =>
  fixture(async (page, cdp) => {
    await page.setContent(
      `<t3-toolbar><button id="save-e1" onclick="this.textContent='saved'">save</button></t3-toolbar>`,
    );
    await snapshot(page, cdp);
    await ServerBrowserPage.click(page, { selector: "t3-toolbar>#save-e1" });
    expect(await page.locator("button").textContent()).toBe("saved");
  }));

it("refuses a stale bare ref at once and before any input", () =>
  fixture(async (page, cdp) => {
    await page.setContent("<button>continue</button>");
    const locator = await bareRef(page, cdp, "continue");
    await snapshot(page, cdp);
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toMatchObject({
      detail: { staleRef: true },
    });
  }));

it("reports a target that is there but never got ready as refused before input", () =>
  fixture(async (page) => {
    await page.setContent("<button hidden id=later>continue</button>");
    await expect(
      ServerBrowserPage.click(page, { selector: "#later", timeoutMs: 200 }),
    ).rejects.toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      detail: { beforeInput: true },
    });
  }));

it("refuses a selector that matches nothing as no match within its short grace, not after the whole wait", () =>
  fixture(async (page) => {
    await page.setContent("<input role=combobox aria-label=Search>");
    // A wait past the grace: the old path spent all of it and answered a timeout. The server
    // browser moves the pointer before typing, so that step is checked on its own too.
    const input = { selector: "input[name=q]", text: "goat", timeoutMs: 6_000 };
    const refusals = await Promise.all(
      [
        pointBefore(
          page,
          input,
          async () => {},
          () => {},
        ),
        ServerBrowserPage.type(page, input),
        ServerBrowserPage.click(page, input),
      ].map((action) =>
        action.then(
          () => "acted",
          (error: unknown) => error,
        ),
      ),
    );
    for (const refusal of refusals)
      expect(refusal).toMatchObject({
        tag: "PreviewAutomationInvalidSelectorError",
        detail: { noMatch: true },
      });
    expect(await page.locator("input").inputValue()).toBe("");
  }));

it("lists interactive-only lines flat, so no control reads as nested under another", () =>
  fixture(async (page, cdp) => {
    await page.setContent(
      `<a href="#gh"><img alt="Fork me" style="position:absolute;width:0;height:0"></a><div><div><button>save</button></div></div>`,
    );
    const lines = String((await snapshot(page, cdp, true)).accessibilityTree)
      .split("\n")
      .slice(1);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line).toMatch(/^- [^\n]*[^:]$/);
  }));
