// Pixel baselines for the Paper bot home (070 Revision A/A2): the v1 lift's scoped CSS must not change a pixel here.
// Reduced motion keeps faces and spinners still; the fake scenes freeze the boards' clock.
import { expect, test } from "@playwright/test";

const scenes = ["2R-1", "FF-1", "U8-1", "12P-1", "25D-0", "2PU-1", "1KL4-1"];
test.use({ viewport: { width: 1440, height: 900 } });

for (const id of scenes) {
  test(`baseline ${id}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/?fake=${id}`);
    if (id === "1KL4-1") { await page.getByLabel("Add a bot to the rail").first().click(); await page.getByLabel("Search bots").fill("rev"); }
    await expect(page.locator("[data-frame], [data-new-bot]").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 899);
    await expect(page).toHaveScreenshot(`${id}.png`, { maxDiffPixels: 0, animations: "disabled", caret: "hide" });
  });
}
