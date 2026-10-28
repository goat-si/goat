import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

describe.skipIf(!chromiumInstalled)("typed text read back", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    page = await (await browser.newContext()).newPage();
  });

  it("confirms typed text only when the field reads back what the text should make of it", async () => {
    await page.setContent(
      '<input id="name"><input id="phone" type="tel"><textarea id="notes"></textarea>' +
        '<input id="word" value="helo"><input id="tail" value="hello">' +
        '<input id="shout" oninput="this.value = this.value.toUpperCase()">' +
        '<div id="rich" contenteditable="true"></div>',
    );
    const typed = (locator: string, text: string, clear = false) =>
      ServerBrowserPage.type(page, { locator, text, ...(clear ? { clear: true } : {}) });
    const confirmed = { effect: "confirmed", evidence: ["value"] };
    await expect(typed("#name", "Ada", true)).resolves.toEqual(confirmed);
    await expect(typed("#phone", "010-1234-5678")).resolves.toEqual(confirmed);
    await expect(typed("#notes", "two\nlines")).resolves.toEqual(confirmed);
    // The caret between "hel" and "o": typing "l" makes "hello".
    await page.evaluate("word.focus(); word.setSelectionRange(3, 3)");
    await expect(typed("#word", "l")).resolves.toEqual(confirmed);
    // A field that already ends in "lo" whose page cancels the typing does not confirm it.
    await page.evaluate("tail.addEventListener('beforeinput', (event) => event.preventDefault())");
    await expect(typed("#tail", "lo")).resolves.toBeUndefined();
    await expect(typed("#name", "")).resolves.toBeUndefined();
    await expect(typed("#shout", "abc", true)).resolves.toBeUndefined();
    await expect(typed("#rich", "text")).resolves.toBeUndefined();
  });
});
