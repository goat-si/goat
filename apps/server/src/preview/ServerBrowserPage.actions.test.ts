import { chromium, type Dialog, type Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import { testActionPage as ServerBrowserPage } from "./actionChannel.testkit.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";

const fixture = async (html: string, run: (page: Page) => Promise<void>) => {
  expect(chromiumInstalled).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent(html);
    await run(page);
  } finally {
    await browser.close();
  }
};

const counted = (page: Page) => page.evaluate("window.clicks ?? 0");

const boxes = `<script>window.clicks = 0;</script>
  <label><input type="checkbox" id="on" checked onclick="clicks++"> On</label>
  <label><input type="checkbox" id="stuck" onclick="clicks++; event.preventDefault()"> Stuck</label>
  <button id="plain" onclick="clicks++">Plain</button>`;

it("checked:true on a checked box sends nothing and keeps it checked", () =>
  fixture(boxes, async (page) => {
    const result = await ServerBrowserPage.click(page, { locator: "#on", checked: true });
    expect(result).toMatchObject({ pressed: false, checked: true });
    expect(result).not.toHaveProperty("effect");
    expect(await counted(page)).toBe(0);
    expect(await page.isChecked("#on")).toBe(true);
  }));

it("checked:false unchecks a checked box with one click and confirms it", () =>
  fixture(boxes, async (page) => {
    const result = await ServerBrowserPage.click(page, { locator: "#on", checked: false });
    expect(result).toMatchObject({ pressed: true, checked: false });
    expect(await counted(page)).toBe(1);
    expect(await page.isChecked("#on")).toBe(false);
  }));

it("a checked click the page ignores fails as sent, naming the state it left", () =>
  fixture(boxes, async (page) => {
    const failure = await ServerBrowserPage.click(page, { locator: "#stuck", checked: true }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ServerBrowserOperationError);
    expect(failure).toMatchObject({ tag: "PreviewAutomationExecutionError" });
    expect((failure as Error).message).toContain("still unchecked");
    expect(await counted(page)).toBe(1);
  }));

it("checked on a control that is not checkable is refused with nothing sent", () =>
  fixture(boxes, async (page) => {
    await expect(
      ServerBrowserPage.click(page, { locator: "#plain", checked: true }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationInvalidSelectorError" });
    expect(await counted(page)).toBe(0);
  }));

const shiftPad = `<script>window.shifts = [];</script>
  <button id="b" onclick="shifts.push(event.shiftKey)" ondblclick="shifts.push('double')">B</button>`;

it("a Shift click reaches the page with shiftKey held, and the next click has it released", () =>
  fixture(shiftPad, async (page) => {
    await ServerBrowserPage.click(page, { locator: "#b", modifiers: ["Shift"] });
    await ServerBrowserPage.click(page, { locator: "#b" });
    expect(await page.evaluate("shifts")).toEqual([true, false]);
  }));

it("held keys come up when the tab is taken between a double click's presses", () =>
  fixture(shiftPad, async (page) => {
    // The gate refuses once the first press landed, as a takeover would.
    const gate = async () => {
      if (((await page.evaluate("shifts.length")) as number) > 0) throw new Error("taken");
    };
    await expect(
      ServerBrowserPage.click(
        page,
        { locator: "#b", clickCount: 2, modifiers: ["Shift"] },
        undefined,
        gate,
      ),
    ).rejects.toThrow("taken");
    await ServerBrowserPage.click(page, { locator: "#b" });
    expect(await page.evaluate("shifts")).toEqual([true, false]);
  }));

it("a dialog a held key opened leaves the click unsent and the key released once answered", () =>
  fixture(
    `<script>window.shifts = [];
      addEventListener("keydown", (event) => event.key === "Shift" && alert("held"), { once: true });</script>
    <button id="b" onclick="shifts.push(event.shiftKey)">B</button>`,
    async (page) => {
      const lingering: Array<Promise<unknown>> = [];
      const gate = Object.assign(() => {}, {
        linger: (work: Promise<unknown>) => void lingering.push(work.catch(() => undefined)),
      });
      const dialog = new Promise<Dialog>((resolve) => page.once("dialog", resolve));
      const result = await ServerBrowserPage.click(
        page,
        { locator: "#b", modifiers: ["Shift"] },
        undefined,
        gate,
      );
      // The keys went out and the click did not: no press of it completed.
      expect(result).toMatchObject({ pressesCompleted: 0 });
      await (await dialog).dismiss();
      await Promise.all(lingering);
      await ServerBrowserPage.click(page, { locator: "#b" });
      expect(await page.evaluate("shifts")).toEqual([false]);
    },
  ));

it("a checked click whose held key opened a dialog does not report the box as pressed", () =>
  fixture(
    `<script>addEventListener("keydown", (event) => event.key === "Shift" && alert("held"), { once: true });</script>
    <input type="checkbox" id="box">`,
    async (page) => {
      const lingering: Array<Promise<unknown>> = [];
      const gate = Object.assign(() => {}, {
        linger: (work: Promise<unknown>) => void lingering.push(work.catch(() => undefined)),
      });
      const dialog = new Promise<Dialog>((resolve) => page.once("dialog", resolve));
      const result = await ServerBrowserPage.click(
        page,
        { locator: "#box", checked: true, modifiers: ["Shift"] },
        undefined,
        gate,
      );
      expect(result).toMatchObject({ pressesCompleted: 0 });
      expect(result).not.toHaveProperty("pressed");
      await (await dialog).dismiss();
      await Promise.all(lingering);
      expect(await page.isChecked("#box")).toBe(false);
    },
  ));

it("a scroll with only a locator brings that element into view", () =>
  fixture(
    `<div style="height:3000px">Top</div><button id="far">Far</button><div style="height:3000px"></div>`,
    async (page) => {
      const result = await ServerBrowserPage.scroll(page, { locator: "#far" });
      const box = await page.locator("#far").boundingBox();
      const viewport = page.viewportSize();
      expect(result.settled).toBe(true);
      expect(box && viewport && box.y >= 0 && box.y + box.height <= viewport.height).toBe(true);
    },
  ));
