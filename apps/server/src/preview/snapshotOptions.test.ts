import { chromium } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import { snapshot, click } from "./ServerBrowserPage.ts";

it("narrows snapshots before budgeting, preserves actionable refs and isolates diff modes", async () => {
  expect(chromiumInstalled).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await page.setContent(
      `<aside>Outside scope</aside><main><p>Article paragraph</p><button onclick="this.insertAdjacentHTML('afterend','<p>Added paragraph</p>')">Add</button></main>`,
    );
    const take = (options = {}) =>
      snapshot({
        page,
        cdp,
        renderScale: 1,
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
        captureImage: false,
        timeoutMs: 5000,
        agentSessionId: "one",
        ...options,
      });
    const interactive = await take({ interactiveOnly: true, diff: true });
    expect(interactive.accessibilityTree).toContain('button "Add"');
    expect(interactive.accessibilityTree).not.toContain("Article paragraph");
    const ref = /\[ref=([^\]]+)\]/.exec(String(interactive.accessibilityTree))?.[1];
    expect(ref).toBeDefined();
    await click(page, { locator: `aria-ref=${ref}` });
    const first = await take({ scope: { selector: "main" }, diff: true });
    expect(first.diff?.base).toBe("none");
    expect(first.visibleText).not.toContain("Outside scope");
    expect(first.accessibilityTree).not.toContain("Outside scope");
    const same = await take({ scope: { selector: "main" }, diff: true });
    expect(same.diff).toEqual({ base: "previous", added: [], removed: [] });
    await page.addStyleTag({ content: "main { padding-left: 17px; }" });
    expect((await take({ scope: { selector: "main" }, diff: true })).diff).toEqual({
      base: "previous",
      added: [],
      removed: [],
    });
    expect(
      (await take({ scope: { selector: "main" }, interactiveOnly: true, diff: true })).diff?.base,
    ).toBe("none");
    expect((await take({ scope: { selector: "main" }, diff: true })).diff?.base).toBe("none");
    await page.getByRole("button").click();
    const added = await take({ scope: { selector: "main" }, diff: true });
    expect(added.diff?.added.filter((line) => line.includes("Added paragraph"))).toHaveLength(1);
    expect(added.diff?.removed).toEqual([]);
    expect(
      (await take({ agentSessionId: "two", scope: { selector: "main" }, diff: true })).diff?.base,
    ).toBe("none");
    await page.goto("about:blank");
    expect((await take({ diff: true })).diff?.base).toBe("none");
    await page.setContent("<div hidden><main>fictional-hidden-token</main></div>");
    expect(JSON.stringify(await take({ scope: { selector: "div[hidden] main" } }))).not.toContain(
      "fictional-hidden-token",
    );
    await page.setContent(
      '<main hidden id=a>fictional-a</main><main style="display:none" id=b>fictional-b</main><main inert id=c>fictional-c</main><main aria-hidden=true id=d>fictional-d</main>',
    );
    for (const id of ["a", "b", "c", "d"]) {
      const scoped = await take({ scope: { selector: `#${id}` }, tabId: "tab-1" });
      expect(JSON.stringify(scoped)).not.toContain(`fictional-${id}`);
      expect(scoped.tabId).toBe("tab-1");
    }
    await page.setContent("<main>" + "<p>Long paragraph</p>".repeat(4000) + "</main>");
    expect((await take()).omitted).toContain("tree_budget");
  } finally {
    await browser.close();
  }
});

it("annotates captured pixels and removes overlays after success and capture failure", async () => {
  expect(chromiumInstalled).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await page.setContent("<button>Capture target</button>");
    const result = await snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      timeoutMs: 5000,
      annotate: true,
    });
    expect(result.screenshot).toBeDefined();
    const pixel = await page.evaluate(`(async () => {
      const image = new Image(); image.src = 'data:image/png;base64,${result.screenshot?.data}'; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width=image.width; canvas.height=image.height;
      const context = canvas.getContext('2d'); context.drawImage(image,0,0); return [...context.getImageData(9,9,1,1).data];
    })()`);
    expect(pixel).toEqual([255, 235, 0, 255]);
    expect(await page.locator('[id^="goat-ref-overlay-"]').count()).toBe(0);
    const { withRefAnnotations } = await import("./annotateRefs.ts");
    await expect(
      withRefAnnotations(page, "- button [ref=e1] [box=8,8,100,21]", async () => {
        expect(await page.locator('[id^="goat-ref-overlay-"]').count()).toBe(1);
        throw new Error("Fixture capture failed");
      }),
    ).rejects.toThrow("Fixture capture failed");
    expect(await page.locator('[id^="goat-ref-overlay-"]').count()).toBe(0);
  } finally {
    await browser.close();
  }
});
