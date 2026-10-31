import { chromium, type Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import { testActionPage as ServerBrowserPage } from "./actionChannel.testkit.ts";
import { pointBefore } from "./ServerBrowserPointer.ts";
import type { PointerReporter } from "./ServerBrowserPage.ts";

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

it("sends no more of a drag once its first move opened a dialog and the tab was taken", () =>
  fixture(async (page) => {
    await page.setContent(
      pointerPad +
        `<script>pad.addEventListener("mousemove", () => alert("held"), { once: true });</script>`,
    );
    const gate = Object.assign(
      () => {
        if (gate.taken) throw new Error("taken");
      },
      { taken: false },
    );
    page.once("dialog", (dialog) => {
      gate.taken = true;
      void dialog.dismiss();
    });
    await expect(
      ServerBrowserPage.drag(
        page,
        { from: { x: 100, y: 100 }, to: { x: 300, y: 200 } },
        undefined,
        gate,
      ),
    ).rejects.toThrow("taken");
    const events = (await page.evaluate("events")) as Array<[string]>;
    expect(events.map(([type]) => type)).toEqual(["mousemove"]);
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

it("points at a field that appears late, within the input's time, and nowhere for focused typing", () =>
  fixture(async (page) => {
    await page.setContent("<body></body>");
    void page.evaluate(`setTimeout(() => document.body.insertAdjacentHTML("beforeend",
      '<input id="f" style="position:fixed;left:100px;top:40px;width:80px;height:20px;border:0;padding:0">'), 800)`);
    const points: Array<[number, number, string]> = [];
    const pointer: PointerReporter = async ({ x, y }, phase) => void points.push([x, y, phase]);
    const typed = await pointBefore(page, { locator: "#f", timeoutMs: 5_000 }, pointer, () => {});
    expect(points).toEqual([[140, 50, "move"]]);
    // The input keeps only what is left of its own time.
    expect(typed.timeoutMs).toBeLessThan(5_000);
    expect(await pointBefore(page, {}, pointer, () => {})).toEqual({});
    expect(points).toHaveLength(1);
  }));

it("draws no pointer for a caller that already gave up", () =>
  fixture(async (page) => {
    await page.setContent('<input id="f">');
    const points: unknown[] = [];
    // The request spent its time queued: the caller's deadline has passed before the move.
    const gate = Object.assign(() => {}, { deadline: 0 });
    await pointBefore(page, { locator: "#f" }, async (point) => void points.push(point), gate);
    expect(points).toEqual([]);
  }));

it("draws no pointer once the action's control changed during the wait", () =>
  fixture(async (page) => {
    await page.setContent('<input id="f">');
    const points: unknown[] = [];
    // A Stop and resume during the wait: the current state allows input, this action's gate does not.
    const gate = Object.assign(() => {}, {
      check: () => {
        throw new Error("control changed");
      },
    });
    await expect(
      pointBefore(page, { locator: "#f" }, async (point) => void points.push(point), gate),
    ).rejects.toThrow("control changed");
    expect(points).toEqual([]);
  }));
