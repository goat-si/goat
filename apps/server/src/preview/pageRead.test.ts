import { chromium, type Page } from "playwright-core";
import { expect, it, vi } from "vite-plus/test";
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
  const browser = await chromium.launch({ headless: true, args: ["--site-per-process"] });
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

it("never returns data URL payloads or text under hidden ancestors", () =>
  fixture(async (page, read) => {
    await page.goto(
      `data:text/html,${encodeURIComponent('<title>Form</title><main>Body</main><input type=password value="fictional pass word!">')}`,
    );
    const result = await read();
    expect(result.url).toBe("data:text/html,…");
    expect(JSON.stringify(result)).not.toMatch(/fictional|pass%20word/);
    await page.setContent(
      "<div hidden><main>fictional-hidden-token</main></div><details><p id=closed>fictional-closed-token</p></details>",
    );
    for (const selector of ["div[hidden] main", "#closed"])
      expect((await read({ scope: { selector } })).text).toBe("");
    await page.setContent(
      "<main hidden id=root>fictional-root-token</main><section id=host><p id=slotted>fictional-slot-token</p></section><script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<div hidden><slot></slot></div>'</script>",
    );
    for (const selector of ["#root", "#slotted"])
      expect((await read({ scope: { selector } })).text).toBe("");
    await page.route("https://outer.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div hidden><iframe src="https://inner.test/"></iframe></div>',
      }),
    );
    await page.route("https://inner.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>fictional-frame-token</p>" }),
    );
    await page.goto("https://outer.test/");
    await page.frameLocator("iframe").locator("p").waitFor({ state: "attached" });
    expect(
      (await read({ scope: { selector: "iframe >> internal:control=enter-frame >> p" } })).text,
    ).toBe("");
  }));

it("refuses a page it cannot render whole instead of returning cut text", () =>
  fixture(async (page, read) => {
    await page.setContent("<main><pre>alpha</pre><p>after</p></main>");
    // The HTML parser flattens nesting past 512 levels, so the deep branch is built through the DOM.
    await page.evaluate(`(() => {
      let node = document.querySelector("pre");
      for (let i = 0; i < 600; i++) node = node.appendChild(document.createElement("span"));
      node.textContent = "fictional-deep-token";
    })()`);
    await expect(read()).rejects.toMatchObject({ detail: { reason: "render_cut" } });
    expect((await read({ scope: { selector: "p" } })).text).toBe("after");
  }));

it("keeps text unread when an ancestor hides it while the read runs", () =>
  fixture(async (page, read) => {
    // The page hides the ancestor the moment the read starts watching it for changes.
    await page.setContent(
      "<div id=box><main>fictional-late-hidden-token</main></div><script>const Observer = MutationObserver; window.MutationObserver = function (callback) { document.querySelector('#box').hidden = true; return new Observer(callback); };</script>",
    );
    const late = await read({ scope: { selector: "main" } });
    expect(JSON.stringify(late)).not.toContain("fictional-late-hidden-token");
  }));

it("pages encoded results without splitting emoji and restarts after mutation or navigation", () =>
  fixture(async (page, read) => {
    const body = `<title>${"Title".repeat(1200)}</title><pre>${`A\n"\\${String.fromCodePoint(0x1f600)}`.repeat(5000)}</pre>`;
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
      message: expect.stringContaining("pass the revision returned with the previous page"),
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

it("reads again instead of refusing when a frame comes or goes during the read, as rotating ads do", () =>
  fixture(async (page, read) => {
    await page.setContent("<main>Portal news</main>");
    const { observed } = await observerGate(page);
    const reading = read();
    await observed;
    await page.evaluate(
      "(() => { const frame = document.createElement('iframe'); frame.srcdoc = '<p>Ad</p>'; document.body.append(frame); })()",
    );
    const result = await reading;
    expect(result.text).toContain("Portal news");
    expect(await page.evaluate("window.activeReadObservers")).toBe(0);
  }));

it("still refuses a secret that disappeared during a read whose frames also changed", () =>
  fixture(async (page, read) => {
    await page.setContent("<main>Public</main><input type=password value=frame-retry-secret>");
    const { observed } = await observerGate(page);
    const reading = read();
    await observed;
    await page.evaluate(
      "(() => { document.querySelector('input').remove(); document.querySelector('main').textContent = 'frame-retry-secret'; const frame = document.createElement('iframe'); frame.srcdoc = '<p>Ad</p>'; document.body.append(frame); })()",
    );
    const outcome = await reading.then(
      (value) => JSON.stringify(value),
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({ detail: { reason: "pageChanged" } });
  }));

it("reports a DOM that has not stayed quiet for settleMs by the deadline", () =>
  fixture(async (page, read) => {
    let started = () => {};
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.exposeFunction("readWaiting", () => started());
    await page.clock.install({ time: "2026-01-01T00:00:00Z" });
    await page.clock.pauseAt("2026-01-01T01:00:00Z");
    // The read adds its load listener in the same step that arms its deadline timer.
    await page.setContent(
      "<main>Changing</main><script>const add = window.addEventListener.bind(window); window.addEventListener = (type, ...rest) => { if (type === 'load') window.readWaiting(); return add(type, ...rest); };</script>",
    );
    const reading = read({ timeoutMs: 150, settleMs: 5_000 });
    // A read that ends before arming its deadline fails here instead of waiting on the hook.
    const first = await Promise.race([
      waiting.then(() => "armed" as const),
      reading.then(
        () => "ended" as const,
        () => "ended" as const,
      ),
    ]);
    expect(first).toBe("armed");
    await page.clock.runFor(200);
    expect(await reading).toMatchObject({
      settled: false,
      pending: { domChanging: true },
      text: "Changing",
    });
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
    // Hold the navigation event so the old context dies before this side learns of the new document.
    const held: Array<Array<unknown>> = [];
    // Playwright's Page is an event emitter, though its public type leaves emit out.
    const emitter = page as unknown as {
      emit: (event: string, ...args: Array<unknown>) => boolean;
    };
    const emit = emitter.emit.bind(page);
    const mocks = new DisposableStack();
    mocks.use(vi.spyOn(page, "url").mockReturnValue(page.url()));
    mocks.use(
      vi.spyOn(emitter, "emit").mockImplementation((event, ...args) => {
        if (event !== "framenavigated") return emit(event, ...args);
        held.push(args);
        return true;
      }),
    );
    const reading = read().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await observed;
    await page.goto("https://read.test/two");
    mocks.dispose();
    expect(held.length).toBeGreaterThan(0);
    for (const args of held) emit("framenavigated", ...args);
    const outcome = await reading;
    expect(outcome).not.toHaveProperty("error");
    if (!("value" in outcome)) return;
    const result = outcome.value;
    expect(result.text).toContain("Replacement document");
    expect(result.text).not.toContain("First document");
    expect(result.text).not.toContain("Unshared frame");
    expect(result.omittedFrames).toBe(1);
  }));

it("withholds a scoped frame read when its secret reader never answers", () =>
  fixture(async (page, read) => {
    await page.route("https://read.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<iframe src="https://private-frame.test/"></iframe>',
      }),
    );
    await page.route("https://private-frame.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<input type="password" value="frame-private-value"><main>frame-private-value</main>',
      }),
    );
    await page.goto("https://read.test/framed");
    const context = page.context();
    const open = context.newCDPSession.bind(context);
    using mocks = new DisposableStack();
    mocks.use(
      vi.spyOn(context, "newCDPSession").mockImplementation(async (target) => {
        const session = await open(target);
        if (target !== page)
          mocks.use(
            vi
              .spyOn(session, "send")
              .mockRejectedValue(new Error("Fixture frame reader unavailable")),
          );
        return session;
      }),
    );
    await expect(
      read({ scope: { selector: "iframe >> internal:control=enter-frame >> main" } }),
    ).rejects.toMatchObject({ detail: { reason: "pageChanged" } });
  }));
