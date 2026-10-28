import { chromium, type Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { PopupAttribution, targetIdOf, watchOpenings } from "./agentTabState.ts";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";

it("gives each real popup to the agent that opened it when their responses arrive out of order", async () => {
  expect(chromiumInstalled).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const tab = {
      control: { agentId: null, generation: 0 },
      agentOperating: true,
      popups: new PopupAttribution(),
    };
    await watchOpenings(await context.newCDPSession(page), tab, () => 0);
    const slow = Promise.withResolvers<void>();
    await context.route("https://popup.test/slow", async (route) => {
      await slow.promise;
      await route.fulfill({ body: "<p>slow</p>", contentType: "text/html" });
    });
    await context.route("https://popup.test/fast", (route) =>
      route.fulfill({ body: "<p>fast</p>", contentType: "text/html" }),
    );
    const owners: Array<[string, string | null]> = [];
    const first = Promise.withResolvers<void>();
    const adopted = Promise.withResolvers<void>();
    page.on("popup", (popup: Page) => {
      void targetIdOf(popup).then((targetId) => {
        owners.push([new URL(popup.url()).pathname, tab.popups.owner(targetId, tab, 0)]);
        if (owners.length === 1) first.resolve();
        if (owners.length === 2) adopted.resolve();
      });
    });
    await page.setContent(
      `<a href="https://popup.test/slow" target="_blank">slow</a> <a href="https://popup.test/fast" target="_blank" rel="noopener">fast</a>`,
    );
    tab.popups.lastInput = { agentId: "agent-a", at: 0, generation: 0 };
    await page.click("text=slow");
    tab.popups.lastInput = { agentId: "agent-b", at: 0, generation: 0 };
    await page.click("text=fast");
    await first.promise;
    slow.resolve();
    await adopted.promise;
    expect(owners).toEqual([
      ["/fast", "agent-b"],
      ["/slow", "agent-a"],
    ]);
  } finally {
    await browser.close();
  }
});
