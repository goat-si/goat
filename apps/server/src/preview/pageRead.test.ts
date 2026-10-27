import { chromium, type Page } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import { pageRead } from "./pageRead.ts";
import { attachNetworkTracker } from "./networkTracker.ts";
import { SessionControl } from "./SessionControl.ts";

const fixture = async (
  run: (
    page: Page,
    read: (input?: Parameters<typeof pageRead>[3]) => ReturnType<typeof pageRead>,
    control: SessionControl,
  ) => Promise<void>,
) => {
  expect(chromiumInstalled).toBe(true);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    attachNetworkTracker(page);
    const cdp = await page.context().newCDPSession(page);
    const control = new SessionControl(null);
    await run(
      page,
      (input = {}) => pageRead(page, cdp, control, { settleMs: 100, ...input }),
      control,
    );
  } finally {
    await browser.close();
  }
};

it("reads visible live DOM, shadows, frames and collapsed summaries without field values", () =>
  fixture(async (page, read) => {
    await page.route("https://read.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<title>Read fixture</title><main><h1>Article</h1><p>Visible paragraph</p><input type=password value=private-value><p>private-value</p><div hidden>Hidden secret</div><div style="display:none">Styled hidden</div><div inert>Inert secret</div><details><summary>Collapsed</summary>Closed content</details><button aria-expanded=false>Expand</button><section id=shadow></section><iframe srcdoc="<p>Frame paragraph</p>"></iframe><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<p>Shadow paragraph</p>'</script></main>`,
      }),
    );
    await page.goto("https://read.test/article");
    const result = await read();
    expect(result).toMatchObject({
      settled: true,
      network: "idle",
      collapsedCount: 2,
      omittedFrames: 0,
    });
    expect(result.text).toContain("# Article");
    expect(result.text).toContain("Shadow paragraph");
    expect(result.text).toContain("Frame paragraph");
    for (const hidden of [
      "private-value",
      "Hidden secret",
      "Styled hidden",
      "Inert secret",
      "Closed content",
    ])
      expect(result.text).not.toContain(hidden);
    expect(
      (await read({ scope: { selector: "iframe >> internal:control=enter-frame >> p" } })).text,
    ).toBe("Frame paragraph");
  }));

it("pages encoded results without splitting emoji and restarts after mutation or navigation", () =>
  fixture(async (page, read) => {
    const body = `<title>${"Title".repeat(1200)}</title><pre>${'A\n"\\😀'.repeat(5000)}</pre>`;
    await page.route("https://read.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body }),
    );
    await page.goto("https://read.test/one");
    const whole = await read({ maxBytes: 48000, maxChars: 60000 });
    let result = await read({ maxBytes: 8192, maxChars: 60000 });
    expect(result.titleTruncated).toBe(true);
    expect(result.title.length).toBeLessThanOrEqual(2048);
    expect(result.text.length).toBeGreaterThan(0);
    let text = result.text;
    while (result.nextOffset !== null) {
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
      expect(result.text.isWellFormed()).toBe(true);
      result = await read({
        offset: result.nextOffset,
        revision: result.revision,
        maxBytes: 8192,
        maxChars: 60000,
      });
      text += result.text;
    }
    expect(text.length).toBe(whole.totalChars);
    expect(text.startsWith(whole.text)).toBe(true);
    await page.goto("https://read.test/two");
    expect(await read({ offset: 10, revision: result.revision })).toMatchObject({
      changed: true,
      offset: 0,
    });
    const current = await read();
    await page.locator("pre").evaluate((node) => {
      node.textContent = "Replacement";
    });
    expect(await read({ offset: 10, revision: current.revision })).toMatchObject({
      changed: true,
      offset: 0,
      text: "~~~\nReplacement\n~~~",
    });
  }));

it("reports pending requests and returns the gated content after release", () =>
  fixture(async (page, read) => {
    const gate = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<void>();
    await page.route("https://read.test/data", async (route) => {
      requested.resolve();
      await gate.promise;
      await route.fulfill({ body: "Gated paragraph" });
    });
    await page.route("https://read.test/article", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<main>Initial</main><script>fetch('/data').then(r=>r.text()).then(t=>document.querySelector('main').textContent=t)</script>`,
      }),
    );
    try {
      await page.goto("https://read.test/article");
      await requested.promise;
      expect(await read({ timeoutMs: 150 })).toMatchObject({
        settled: false,
        network: "busy",
        pendingRequests: 1,
      });
      gate.resolve();
      await page.getByText("Gated paragraph", { exact: true }).waitFor();
      expect(await read()).toMatchObject({
        settled: true,
        network: "idle",
        text: "Gated paragraph",
      });
    } finally {
      gate.resolve();
    }
  }));

it("refuses private overlap, changed secrets, missing scopes and unversioned offsets", () =>
  fixture(async (page, read, control) => {
    await page.setContent(
      "<main>Public</main><main>Second</main><input type=password value=before>",
    );
    await expect(read({ offset: 1 })).rejects.toMatchObject({
      detail: { reason: "revision_required" },
    });
    await expect(read({ scope: { selector: "main" } })).rejects.toMatchObject({
      detail: { reason: "scope_ambiguous" },
    });
    await expect(read({ scope: { selector: ".missing" } })).rejects.toMatchObject({
      detail: { reason: "scope_not_found" },
    });
    await expect(read({ scope: { ref: "expired-ref" } })).rejects.toMatchObject({
      detail: { reason: "stale_ref" },
    });
    control.setPrivate(true);
    await expect(read()).rejects.toMatchObject({ reason: "privateMode" });
    control.setPrivate(false);
  }));

const observerGate = async (page: Page) => {
  const observed = Promise.withResolvers<void>();
  await page.exposeFunction("readObserved", () => observed.resolve());
  await page.evaluate(`(() => {
    const Original = window.MutationObserver;
    window.activeReadObservers = 0;
    window.MutationObserver = class extends Original {
      constructor(callback) { super(callback); this.readObserver = String(callback).includes("lastMutation"); this.active = this.readObserver; if(this.active) { window.activeReadObservers++; window.readObserved(); } }
      disconnect() { if(this.active) window.activeReadObservers--; this.active = false; super.disconnect(); }
    };
  })()`);
  return { observed: observed.promise };
};

it("withholds results across a private period and disconnects the read observer", () =>
  fixture(async (page, read, control) => {
    await page.setContent("<main>Public</main>");
    const { observed } = await observerGate(page);
    const reading = read();
    await observed;
    control.setPrivate(true);
    control.setPrivate(false);
    await expect(reading).rejects.toMatchObject({ reason: "privateMode" });
    expect(await page.evaluate("window.activeReadObservers")).toBe(0);
  }));

it("refuses a changed secret even when its new value appeared in page text during the read", () =>
  fixture(async (page, read) => {
    await page.setContent("<main>Public</main><input type=password value=before-value>");
    const { observed } = await observerGate(page);
    const reading = read();
    await observed;
    await page.evaluate(
      "document.querySelector('input').value='after-value';document.querySelector('main').textContent='after-value'",
    );
    await expect(reading).rejects.toMatchObject({ detail: { reason: "pageChanged" } });
    expect(await page.evaluate("window.activeReadObservers")).toBe(0);
  }));

it("reports a continuously changing DOM without leaving its observer active", () =>
  fixture(async (page, read) => {
    await page.setContent("<main>Changing</main>");
    await page.evaluate(
      `(() => { let tick = 0; const change = () => { document.querySelector('main').textContent = String(++tick); window.readFrame = requestAnimationFrame(change); }; change(); })()`,
    );
    try {
      expect(await read({ timeoutMs: 150 })).toMatchObject({
        settled: false,
        pending: { domChanging: true },
      });
    } finally {
      await page.evaluate("cancelAnimationFrame(window.readFrame)");
    }
  }));

it("keeps late network coverage unknown across same-document navigation", () =>
  fixture(async (page) => {
    const late = await page.context().newPage();
    const gate = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<void>();
    await late.route("https://late.test/data", async (route) => {
      requested.resolve();
      await gate.promise;
      await route.fulfill({ body: "Done" });
    });
    await late.route("https://late.test/page", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<p>Late</p><script>fetch('/data')</script>",
      }),
    );
    try {
      await late.goto("https://late.test/page");
      await requested.promise;
      const tracker = attachNetworkTracker(late);
      expect(tracker.state()).toMatchObject({ network: "unknown", documentId: 0 });
      await late.evaluate("history.pushState(null,'','#same')");
      expect(tracker.state()).toMatchObject({ network: "unknown", documentId: 0 });
      gate.resolve();
      await late.goto("https://late.test/page");
      await late.waitForLoadState("load");
      expect(tracker.state().documentId).toBe(1);
      expect(tracker.state().network).not.toBe("unknown");
    } finally {
      gate.resolve();
      await late.close();
    }
  }));

it("keeps simultaneous observers consistent and refuses a metadata-only output overflow", () =>
  fixture(async (page, read, control) => {
    await page.setContent("<title>" + "Metadata".repeat(400) + "</title><main>Shared text</main>");
    await control.take("human-viewer");
    const [one, two] = await Promise.all([read(), read()]);
    expect(one.text).toBe("Shared text");
    expect(two.text).toBe(one.text);
    expect(two.revision).toBe(one.revision);
    expect(control.controller).toBe("human-viewer");
    await expect(read({ maxBytes: 1000 })).rejects.toMatchObject({
      detail: { reason: "output_limit" },
    });
  }));

it("retries a document replaced during settling and counts unreadable frames", () =>
  fixture(async (page, read) => {
    await page.route("https://read.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: route.request().url().endsWith("/one")
          ? "<main>First document</main>"
          : '<main>Replacement document</main><iframe src="https://frame.test/"></iframe>',
      }),
    );
    await page.route("https://frame.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>Unshared frame</p>" }),
    );
    await page.goto("https://read.test/one");
    const { observed } = await observerGate(page);
    const reading = read();
    await observed;
    await page.goto("https://read.test/two");
    const result = await reading;
    expect(result.text).toContain("Replacement document");
    expect(result.text).not.toContain("First document");
    expect(result.text).not.toContain("Unshared frame");
    expect(result.omittedFrames).toBe(1);
  }));
