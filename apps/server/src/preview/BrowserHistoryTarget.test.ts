import { historyTestChannel } from "./BrowserHistoryTestChannel.testkit.ts";
import { chromium } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { browserHistoryTarget } from "./BrowserHistoryTarget.ts";

it("labels a click target without exposing a password field value", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent('<button aria-label="Save">Save</button>');
    expect(
      await browserHistoryTarget(page, { selector: "button" }, await historyTestChannel(page)),
    ).toBe("button: Save");
    await page.setContent('<input type="password" aria-label="Password" value="private-secret">');
    const password = await browserHistoryTarget(
      page,
      { selector: "input" },
      await historyTestChannel(page),
    );
    expect(password).toBe("textbox");
    expect(password).not.toContain("private-secret");
    await page.setContent('<button aria-label="private-secret">Continue</button>');
    expect(
      await browserHistoryTarget(page, { selector: "button" }, await historyTestChannel(page)),
    ).toBe("button");
  } finally {
    await browser.close();
  }
});
