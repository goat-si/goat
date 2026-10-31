import { chromium, type Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

// These drive headless Chromium, as the CU Lab fixture (160_cu_benchmark cu_lab.html) found the bugs.
const fixture = async (run: (page: Page) => Promise<void>) => {
  expect(chromiumInstalled).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    await run(await (await browser.newContext()).newPage());
  } finally {
    await browser.close();
  }
};

const settledLater = <A>(work: Promise<A>) => {
  const state = { done: false };
  void work.then(
    () => {
      state.done = true;
    },
    () => undefined,
  );
  return state;
};

it("waits for a disabled button to become enabled before answering", () =>
  fixture(async (page) => {
    await page.setContent('<button id="go" disabled>Continue</button>');
    // While it stays disabled the wait times out naming the condition, rather than answering met.
    await expect(
      ServerBrowserPage.waitFor(page, {
        locator: 'role=button[name="Continue" s]',
        enabled: true,
        timeoutMs: 200,
      }),
    ).rejects.toThrow("enabled=true");
    const waiting = ServerBrowserPage.waitFor(page, {
      locator: 'role=button[name="Continue" s]',
      enabled: true,
      timeoutMs: 5_000,
    });
    const state = settledLater(waiting);
    await page.evaluate("document.body.innerText");
    expect(state.done).toBe(false);
    await page.evaluate("go.disabled = false");
    await waiting;
  }));

it("waits for an exact value, a checked box and a selected option, and names what never held", () =>
  fixture(async (page) => {
    await page.setContent(
      '<input id="v" value="a"><input id="c" type="checkbox"><select id="s"><option>x</option><option id="y">y</option></select><p id="t">  ready </p>',
    );
    await expect(
      ServerBrowserPage.waitFor(page, { selector: "#v", value: "b", timeoutMs: 200 }),
    ).rejects.toThrow('value="b"');
    const typed = ServerBrowserPage.waitFor(page, { selector: "#v", value: "b", timeoutMs: 5_000 });
    await page.evaluate("v.value = 'b'");
    await typed;
    const checked = ServerBrowserPage.waitFor(page, {
      selector: "#c",
      checked: true,
      timeoutMs: 5_000,
    });
    await page.evaluate("c.checked = true");
    await checked;
    const selected = ServerBrowserPage.waitFor(page, {
      selector: "#y",
      selected: true,
      timeoutMs: 5_000,
    });
    await page.evaluate("s.value = 'y'");
    await selected;
    await ServerBrowserPage.waitFor(page, { selector: "#t", value: "ready", timeoutMs: 1_000 });
    // A paragraph has no checked state, so it never matches one.
    await expect(
      ServerBrowserPage.waitFor(page, { selector: "#t", checked: false, timeoutMs: 200 }),
    ).rejects.toThrow("checked=false");
  }));

it("never matches conditions that only hold at different moments", () =>
  fixture(async (page) => {
    // Enabled while the value is "a", disabled while it is "b": enabled with "b" never holds.
    await page.setContent(
      '<input id="x" value="a"><script>setInterval(() => { const b = x.value === "a"; x.value = b ? "b" : "a"; x.disabled = b; }, 5)</script>',
    );
    await expect(
      ServerBrowserPage.waitFor(page, {
        selector: "#x",
        enabled: true,
        value: "b",
        timeoutMs: 500,
      }),
    ).rejects.toThrow('enabled=true, value="b"');
  }));

it("never matches visibility and an element condition that hold at different moments", () =>
  fixture(async (page) => {
    // Shown only while disabled, hidden once enabled: visible and enabled never hold together.
    await page.setContent(
      '<button id="b" disabled>Go</button><script>setInterval(() => { b.disabled = !b.disabled; b.hidden = !b.disabled; }, 5)</script>',
    );
    await expect(
      ServerBrowserPage.waitFor(page, {
        selector: "#b",
        state: "visible",
        enabled: true,
        timeoutMs: 500,
      }),
    ).rejects.toThrow("enabled=true");
  }));

it("judges a display: contents target visible through its children, and reads page text and URL from the main page", () =>
  fixture(async (page) => {
    await page.route("https://lab.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<p>Main ready</p><div id="c" style="display:contents"><button>Inner</button></div><div id="t" style="display:contents">Ready</div><iframe srcdoc="<button>Frame</button>"></iframe>',
      }),
    );
    await page.goto("https://lab.test/");
    await ServerBrowserPage.waitFor(page, {
      selector: "#c",
      state: "visible",
      enabled: true,
      timeoutMs: 2_000,
    });
    // Its own text alone shows it too.
    await ServerBrowserPage.waitFor(page, {
      selector: "#t",
      state: "visible",
      enabled: true,
      timeoutMs: 2_000,
    });
    await page.frameLocator("iframe").getByRole("button").waitFor();
    const tree = String(
      (
        await ServerBrowserPage.snapshot({
          page,
          cdp: await page.context().newCDPSession(page),
          renderScale: 1,
          consoleEntries: [],
          networkEntries: [],
          actionTimeline: [],
          timeoutMs: 15_000,
        })
      ).accessibilityTree,
    );
    const ref = /button "Frame" \[ref=([^\]]+)\]/.exec(tree)?.[1];
    expect(ref).toBeDefined();
    // The button is in the frame; the text and URL are the main page's.
    await ServerBrowserPage.waitFor(page, {
      locator: `aria-ref=${ref}`,
      enabled: true,
      text: "Main ready",
      urlIncludes: "lab.test",
      timeoutMs: 2_000,
    });
  }));

it("treats a mixed checkbox as neither checked nor unchecked", () =>
  fixture(async (page) => {
    await page.setContent(
      '<div id="m" role="checkbox" aria-checked="mixed">All</div><input id="i" type="checkbox"><script>i.indeterminate = true</script>',
    );
    for (const selector of ["#m", "#i"])
      for (const checked of [true, false])
        await expect(
          ServerBrowserPage.waitFor(page, { selector, checked, timeoutMs: 200 }),
        ).rejects.toThrow(`checked=${checked}`);
  }));

it("refuses an element condition on several matches instead of picking one", () =>
  fixture(async (page) => {
    await page.setContent('<button class="m">A</button><button class="m">B</button>');
    await expect(
      ServerBrowserPage.waitFor(page, { selector: ".m", enabled: true, timeoutMs: 1_000 }),
    ).rejects.toThrow();
  }));

it("answers a scroll once the nested container and the window stopped moving", () =>
  fixture(async (page) => {
    await page.setContent(
      '<div id="nest" style="height:90px;overflow:auto"><div style="height:400px">top</div></div><div style="height:3000px"></div>',
    );
    await expect(
      ServerBrowserPage.scroll(page, { selector: "#nest", deltaY: 200 }),
    ).resolves.toEqual({
      settled: true,
    });
    expect(await page.evaluate("nest.scrollTop")).toBe(200);
    await expect(ServerBrowserPage.scroll(page, { deltaY: 300 })).resolves.toEqual({
      settled: true,
    });
    // At the bottom nothing moves, and the scroll still settles.
    await page.evaluate("scrollTo(0, document.body.scrollHeight)");
    await expect(ServerBrowserPage.scroll(page, { deltaY: 300 })).resolves.toEqual({
      settled: true,
    });
    await expect(ServerBrowserPage.scroll(page, { x: 20, y: 20, deltaY: 50 })).resolves.toEqual({
      settled: true,
    });
  }));

it("answers settled: false when the gate's deadline leaves no time to watch the scroll", () =>
  fixture(async (page) => {
    await page.setContent('<div style="height:3000px"></div>');
    // The gate's deadline is on the performance.now() clock; 0 has long passed.
    const gate = Object.assign(() => undefined, { deadline: 0 });
    await expect(ServerBrowserPage.scroll(page, { deltaY: 100 }, gate)).resolves.toEqual({
      settled: false,
    });
  }));

it("answers settled: false in time when the page's frames stopped", () =>
  fixture(async (page) => {
    await page.setContent('<div style="height:3000px"></div>');
    await page.evaluate("window.requestAnimationFrame = () => 0");
    await expect(ServerBrowserPage.scroll(page, { deltaY: 100 })).resolves.toEqual({
      settled: false,
    });
  }));

it("sets a range input, fires input and change, and confirms only the value that stayed", () =>
  fixture(async (page) => {
    await page.setContent(
      '<input id="rng" type="range" min="0" max="100" value="10" oninput="log.push(\'input \' + this.value)" onchange="log.push(\'change \' + this.value)"><input id="pushy" type="range" oninput="this.value = 5"><script>var log = []</script>',
    );
    await expect(
      ServerBrowserPage.type(page, { selector: "#rng", text: "70", clear: true }),
    ).resolves.toEqual({ value: "70", effect: "confirmed", evidence: ["value"] });
    expect(await page.evaluate("log")).toEqual(["input 70", "change 70"]);
    // The browser clamps out-of-range values; the clamped value is the one confirmed.
    await expect(
      ServerBrowserPage.type(page, { selector: "#rng", text: "150", clear: true }),
    ).resolves.toMatchObject({ value: "100", effect: "confirmed" });
    await expect(
      ServerBrowserPage.type(page, { selector: "#pushy", text: "70", clear: true }),
    ).resolves.toMatchObject({ value: "5", effect: "unverifiable" });
    // Typing keystrokes into a slider is still refused.
    await expect(ServerBrowserPage.type(page, { selector: "#rng", text: "7" })).rejects.toThrow(
      "not an enabled text field",
    );
  }));

it("hovers a row so its hover-only button shows", () =>
  fixture(async (page) => {
    await page.setContent(
      '<style>.row .act{visibility:hidden}.row:hover .act{visibility:visible}</style><div class="row">Row A <button class="act">Archive</button></div>',
    );
    await ServerBrowserPage.hover(page, { selector: ".row" });
    expect(await page.locator(".act").isVisible()).toBe(true);
  }));

it("a click with clickCount 2 lands two clicks and one double click, as the cell API's count 2 sends", () =>
  fixture(async (page) => {
    await page.setContent(
      '<canvas id="cv" width="300" height="120"></canvas><script>window.seen = [];' +
        'cv.addEventListener("click", () => seen.push("click"));' +
        'cv.addEventListener("dblclick", () => seen.push("dblclick"));</script>',
    );
    await ServerBrowserPage.click(page, { selector: "#cv", clickCount: 2 });
    expect(await page.evaluate("seen")).toEqual(["click", "click", "dblclick"]);
  }));

it("hovers the first of several rows a CSS class names, and a click there still needs one", () =>
  fixture(async (page) => {
    await page.setContent(
      "<style>.row .act{visibility:hidden}.row:hover .act{visibility:visible}</style>" +
        '<div class="row">Row A <button class="act" onclick="window.hit = 1">Archive</button></div>' +
        '<div class="row">Row B <button class="act">Archive</button></div>',
    );
    await ServerBrowserPage.hover(page, { selector: ".row" });
    expect(await page.locator(".act").first().isVisible()).toBe(true);
    // The browser request turns Playwright's strict refusal into the error the agent reads.
    const refused = await ServerBrowserPage.click(page, {
      selector: ".row",
      timeoutMs: 1_000,
    }).catch((cause: unknown) => cause);
    expect(ServerBrowserPage.toOperationError(refused)).toMatchObject({
      tag: "PreviewAutomationInvalidSelectorError",
      detail: { matchCount: 2 },
    });
    expect(await page.evaluate("window.hit")).toBeUndefined();
  }));

it("refuses a selector it cannot parse before the pointer moves", () =>
  fixture(async (page) => {
    await page.setContent('<div class="row">Row A</div>');
    const moves: Array<string> = [];
    const refused = await ServerBrowserPage.hover(
      page,
      { selector: "div[" },
      async (_point, phase) => void moves.push(phase),
    ).catch((cause: unknown) => cause);
    expect(ServerBrowserPage.toOperationError(refused)).toMatchObject({
      tag: "PreviewAutomationInvalidSelectorError",
    });
    expect(moves).toEqual([]);
  }));

it("fails typing into a selector that matches nothing as a miss, before its timeout", () =>
  fixture(async (page) => {
    await page.setContent('<input role="combobox" aria-label="Search">');
    const refused = await ServerBrowserPage.type(page, {
      locator: "input[name=q]",
      text: "goat",
      timeoutMs: 5_000,
    }).catch((cause: unknown) => cause);
    expect(ServerBrowserPage.toOperationError(refused)).toMatchObject({
      tag: "PreviewAutomationInvalidSelectorError",
      detail: { matchCount: 0 },
    });
  }));
