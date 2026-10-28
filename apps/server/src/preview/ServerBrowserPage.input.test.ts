import { chromium, type Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
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

const pointerPad = `<div id="pad" style="position:fixed;inset:0"></div><script>
  window.events = [];
  for (const type of ["mousedown", "mousemove", "mouseup", "wheel"])
    pad.addEventListener(type, (e) => events.push([type, e.clientX, e.clientY, e.deltaY ?? 0]), { passive: true });
  window.wheeled = new Promise((resolve) =>
    pad.addEventListener("wheel", (e) => resolve([e.clientX, e.clientY, e.deltaY]), { once: true }));
</script>`;

it("drags between two page points, as a map or canvas needs", () =>
  fixture(async (page) => {
    await page.setContent(pointerPad);
    await ServerBrowserPage.drag(page, {
      from: { x: 100, y: 100 },
      to: { x: 300, y: 200 },
      steps: 4,
    });
    const events = (await page.evaluate("events")) as Array<[string, number, number, number]>;
    expect(events.find(([type]) => type === "mousedown")).toEqual(["mousedown", 100, 100, 0]);
    expect(events.filter(([type]) => type === "mousemove").length).toBeGreaterThanOrEqual(4);
    expect(events.at(-1)).toEqual(["mouseup", 300, 200, 0]);
  }));

it("wheels at a page point, so the element under it receives the wheel", () =>
  fixture(async (page) => {
    await page.setContent(pointerPad);
    await ServerBrowserPage.scroll(page, { x: 150, y: 120, deltaY: -240 });
    expect(await page.evaluate("wheeled")).toEqual([150, 120, -240]);
  }));

it.each([
  `getByRole('button', { name: 'Save' })`,
  `page.getByRole("button", { name: "Save", exact: true })`,
  `getByText('Save')`,
  `getByTestId('save')`,
  `getByTitle("Save it")`,
])("reads a Playwright getBy locator written as code (%s)", (locator) =>
  fixture(async (page) => {
    await page.setContent(
      `<button data-testid="save" title="Save it" onclick="this.textContent='saved'">Save</button><button>Cancel</button>`,
    );
    await ServerBrowserPage.click(page, { locator });
    expect(await page.locator("button").first().textContent()).toBe("saved");
  }),
);

it.each([
  "getByRole('button').first()",
  "getByRole('checkbox', { name: 'Subscribe', checked: true })",
  "getByRole('button', { name: computedName })",
  "getByText('\\u0041', { exact: true })",
  "getByText(`${label}`)",
])("refuses getBy code it cannot read exactly before any input (%s)", (locator) =>
  fixture(async (page) => {
    await page.setContent(
      `<button onclick="this.textContent='hit'">u0041</button><input type="checkbox" aria-label="Subscribe">`,
    );
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toMatchObject({
      tag: "PreviewAutomationInvalidSelectorError",
    });
    expect(await page.locator("button").textContent()).toBe("u0041");
  }),
);
