import { chromium, type Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

const fixture = async (run: (page: Page) => Promise<void>, args: ReadonlyArray<string> = []) => {
  expect(chromiumInstalled).toBe(true);
  const browser = await chromium.launch({ headless: true, args: [...args] });
  try {
    const page = await (await browser.newContext()).newPage();
    await run(page);
  } finally {
    await browser.close();
  }
};

/** Marks the moment an action found its target not ready and began to wait for it. */
const barrier = () => {
  const waiting = Promise.withResolvers<void>();
  return {
    readiness: { onWaiting: () => waiting.resolve() },
    reached: (action: Promise<unknown>) =>
      Promise.race([
        waiting.promise.then(() => "waiting" as const),
        action.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
      ]),
  };
};

const stopGate = () => {
  const gate = Object.assign(
    () => {
      if (gate.stopped) throw new Error("stopped");
    },
    { stopped: false },
  );
  return gate;
};

it.each([
  ["a disabled input", '<input id="f" disabled>', "f.disabled = false"],
  ["a read-only input", '<input id="f" readonly>', "f.readOnly = false"],
  ["a disabled textarea", '<textarea id="f" disabled></textarea>', "f.disabled = false"],
])("types into %s once the page makes it writable", (_name, html, enable) =>
  fixture(async (page) => {
    await page.setContent(html);
    const { readiness, reached } = barrier();
    const typing = ServerBrowserPage.type(
      page,
      { locator: "#f", text: "hello" },
      undefined,
      readiness,
    );
    expect(await reached(typing)).toBe("waiting");
    await page.evaluate(enable);
    await typing;
    expect(await page.inputValue("#f")).toBe("hello");
  }),
);

it("types into the focused field once it stops being read-only", () =>
  fixture(async (page) => {
    await page.setContent('<input id="f" readonly>');
    await page.focus("#f");
    const { readiness, reached } = barrier();
    const typing = ServerBrowserPage.type(page, { text: "hello" }, undefined, readiness);
    expect(await reached(typing)).toBe("waiting");
    await page.evaluate("f.readOnly = false");
    await typing;
    expect(await page.inputValue("#f")).toBe("hello");
  }));

it("names a field that stayed disabled and never types into it later", () =>
  fixture(async (page) => {
    await page.setContent('<input id="f" disabled>');
    await expect(
      ServerBrowserPage.type(page, { locator: "#f", text: "late", timeoutMs: 300 }),
    ).rejects.toMatchObject({
      tag: "PreviewAutomationTargetNotEditableError",
      message: expect.stringContaining("stayed disabled or read-only"),
    });
    await page.evaluate("f.disabled = false");
    expect(await page.inputValue("#f")).toBe("");
  }));

it("sends no input once the request's deadline has passed, even to a ready field", () =>
  fixture(async (page) => {
    await page.setContent('<input id="f">');
    const expiredGate = Object.assign(() => {}, { deadline: 0 });
    await expect(
      ServerBrowserPage.type(page, { locator: "#f", text: "late" }, expiredGate),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
    await expect(
      ServerBrowserPage.select(page, { locator: "#f", values: [] }, expiredGate),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
    expect(await page.inputValue("#f")).toBe("");
  }));

it("types nothing when Stop arrives while it waits for the field", () =>
  fixture(async (page) => {
    await page.setContent('<input id="f" disabled>');
    const gate = stopGate();
    const { readiness, reached } = barrier();
    const typing = ServerBrowserPage.type(page, { locator: "#f", text: "x" }, gate, readiness);
    expect(await reached(typing)).toBe("waiting");
    gate.stopped = true;
    await page.evaluate("f.disabled = false");
    await expect(typing).rejects.toThrow("stopped");
    expect(await page.inputValue("#f")).toBe("");
  }));

it.each([
  ["a visible select", '<select id="s"><option value="a">A</option></select>'],
  ["a hidden native select", '<select id="s" hidden><option value="a">A</option></select>'],
])("selects an option the page adds to %s after the action began", (_name, html) =>
  fixture(async (page) => {
    await page.setContent(html);
    const { readiness, reached } = barrier();
    const selecting = ServerBrowserPage.select(
      page,
      { locator: "#s", values: ["b"] },
      undefined,
      readiness,
    );
    expect(await reached(selecting)).toBe("waiting");
    await page.evaluate("s.add(new Option('B', 'b'))");
    expect(await selecting).toEqual({ selected: ["b"] });
  }),
);

it("waits for a select inside a disabled fieldset instead of changing it", () =>
  fixture(async (page) => {
    await page.setContent(
      '<fieldset id="box" disabled><select id="s"><option value="a">A</option><option value="b">B</option></select></fieldset>',
    );
    const { readiness, reached } = barrier();
    const selecting = ServerBrowserPage.select(
      page,
      { locator: "#s", values: ["b"] },
      undefined,
      readiness,
    );
    expect(await reached(selecting)).toBe("waiting");
    expect(await page.evaluate("s.value")).toBe("a");
    await page.evaluate("box.disabled = false");
    expect(await selecting).toEqual({ selected: ["b"] });
  }));

it("waits for a late option inside a cross-origin frame", () =>
  fixture(
    async (page) => {
      await page.route("https://parent.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<iframe src="https://child.test/"></iframe>',
        }),
      );
      await page.route("https://child.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<select id="s"><option value="a">A</option></select>',
        }),
      );
      await page.goto("https://parent.test/");
      const child = page.frameLocator("iframe").locator("#s");
      await child.waitFor({ state: "attached" });
      const { readiness, reached } = barrier();
      const selecting = ServerBrowserPage.select(
        page,
        { locator: "iframe >> internal:control=enter-frame >> #s", values: ["b"] },
        undefined,
        readiness,
      );
      expect(await reached(selecting)).toBe("waiting");
      await child.evaluate((select) =>
        (select as unknown as { add(option: unknown): void }).add(
          new (
            globalThis as unknown as { Option: new (label: string, value: string) => unknown }
          ).Option("B", "b"),
        ),
      );
      expect(await selecting).toEqual({ selected: ["b"] });
    },
    ["--site-per-process"],
  ));

it("says it waited when the option never appears, and selects nothing", () =>
  fixture(async (page) => {
    await page.setContent('<select id="s"><option value="a">A</option></select>');
    await expect(
      ServerBrowserPage.select(page, { locator: "#s", values: ["z"], timeoutMs: 300 }),
    ).rejects.toThrow('still has no option "z"');
    expect(await page.evaluate("s.value")).toBe("a");
  }));
