import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import { snapshot } from "./ServerBrowserPage.ts";
import { testActionPage } from "./actionChannel.testkit.ts";

const PAGE = `<p>Article paragraph</p>
<div id="card" style="cursor:pointer" onclick="this.dataset.hit = 'yes'"><span>Open</span><div>card</div></div>
<ul role="listbox" aria-label="Fruits"><li role="option">Apple</li></ul>
<div role="menu"><div role="menuitemcheckbox" aria-checked="true">Bold</div><div role="menuitemradio" aria-checked="false">Left</div></div>
<iframe title="payment" srcdoc="<button>Pay</button>"></iframe>
<input value="draft text">
<button onclick="document.body.dataset.saved = 'yes'">Save</button>`;

const withPage = async (run: (page: Page, cdp: CDPSession) => Promise<void>) => {
  expect(chromiumInstalled).toBe(true);
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await page.setContent(PAGE);
    await run(page, cdp);
  } finally {
    await browser.close();
  }
};

const take = (page: Page, cdp: CDPSession, interactiveOnly?: boolean) =>
  snapshot({
    page,
    cdp,
    renderScale: 1,
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
    captureImage: false,
    timeoutMs: 5000,
    ...(interactiveOnly ? { interactiveOnly } : {}),
  });

it("an interactive-only snapshot keeps listboxes, menu checkbox and radio items, frames and pointer-cursor elements", () =>
  withPage(async (page, cdp) => {
    const tree = String((await take(page, cdp, true)).accessibilityTree);
    expect(tree).toMatch(/^- listbox "Fruits" \[ref=/m);
    expect(tree).toMatch(/^- menuitemcheckbox "Bold" \[checked\] \[ref=/m);
    expect(tree).toMatch(/^- menuitemradio "Left" \[ref=/m);
    expect(tree).toMatch(/^- iframe \[ref=/m);
    expect(tree).toMatch(/^- button "Pay" \[ref=\S+f\d+e\d+\]/m);
    expect(tree).toMatch(/^- generic "Open card" \[ref=\S+\] \[cursor=pointer\]/m);
    expect(tree).not.toContain("Article paragraph");
    for (const line of tree.split("\n").slice(1)) expect(line).toMatch(/^- [^\n]*[^:]$/);
    const ref = /^- generic "Open card" \[ref=(\S+)\] \[cursor=pointer\]/m.exec(tree)?.[1];
    await testActionPage.click(page, { locator: `aria-ref=${ref}` });
    expect(await page.locator("#card").getAttribute("data-hit")).toBe("yes");
  }));

it("a snapshot lists each interactive ref with a locator that acts on it", () =>
  withPage(async (page, cdp) => {
    const result = await take(page, cdp);
    const tree = String(result.accessibilityTree);
    const save = result.interactiveElements.find((element) => element.name === "Save");
    expect(save).toMatchObject({
      role: "button",
      selector: expect.stringMatching(/^aria-ref=t3-/),
    });
    const ref = save!.selector.slice("aria-ref=".length);
    const line = tree.split("\n").find((each) => each.includes(`[ref=${ref}]`));
    expect(line).toContain('button "Save"');
    expect(line).toContain(`[box=${save!.x},${save!.y},${save!.width},${save!.height}]`);
    expect(result.interactiveElements.map((element) => element.role)).toEqual(
      expect.arrayContaining([
        "generic",
        "listbox",
        "option",
        "menuitemcheckbox",
        "menuitemradio",
        "iframe",
        "button",
      ]),
    );
    expect(result.interactiveElements.find((element) => element.name === "Open card")?.role).toBe(
      "generic",
    );
    // A field's content is the user's input, never its name.
    expect(result.interactiveElements.find((element) => element.role === "textbox")?.name).toBe("");
    expect(result.interactiveElements.some((element) => element.name.includes("Article"))).toBe(
      false,
    );
    await testActionPage.click(page, { locator: save!.selector });
    expect(await page.locator("body").getAttribute("data-saved")).toBe("yes");
  }));
