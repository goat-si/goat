// @effect-diagnostics nodeBuiltinImport:off - one-time dummy credential values come from node:crypto.
import * as NodeCrypto from "node:crypto";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import { ServerBrowserDiagnostics } from "./ServerBrowserDiagnostics.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

describe.skipIf(!chromiumInstalled)("server browser credential values", () => {
  let browser: Browser;
  let context: BrowserContext;
  const origin = "http://credentials.test";
  // One-time values, made per run, so no real credential can appear in a log.
  const session = `sess_${NodeCrypto.randomUUID()}`;
  const script = `js_${NodeCrypto.randomUUID()}`;
  const password = `pw_${NodeCrypto.randomUUID()}`;
  const scoped = `path_${NodeCrypto.randomUUID()}`;
  const framed = `frame_${NodeCrypto.randomUUID()}`;
  const fetched = `api_${NodeCrypto.randomUUID()}`;
  const decoy = "tok_0123456789abcdef_not_a_cookie";

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    await context.addCookies([
      { name: "sid", value: session, url: origin, httpOnly: true },
      { name: "js", value: script, url: origin },
      { name: "lang", value: "en", url: origin },
      { name: "scoped", value: scoped, domain: "credentials.test", path: "/app" },
      { name: "framed", value: framed, url: "http://frame.test" },
    ]);
    await context.route("http://frame.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: `<p>Frame echo: ${framed}</p>` }),
    );
    await context.route(`${origin}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<title>Hi ${session}</title><p>Echo: sid=${session}; js=${script}; lang=en</p><p>${decoy}</p><input id="pw" type="password"><iframe src="http://frame.test/"></iframe>`,
      }),
    );
  });
  afterEach(async () => {
    await context.close();
  });

  const open = async () => {
    const page = await context.newPage();
    await page.goto(`${origin}/?echo=${script}`);
    await page.frameLocator("iframe").locator("p").waitFor();
    await page.locator("#pw").fill(password);
    await page.locator("body").click({ position: { x: 900, y: 700 } });
    return { page, cdp: await context.newCDPSession(page) };
  };

  it("keeps the tab's cookie values out of snapshot text, leaving other text alone", async () => {
    const { page, cdp } = await open();
    const snapshot = await ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      captureImage: false,
      consoleEntries: [{ text: `sid=${session}` }] as never,
      networkEntries: [{ url: `${origin}/?js=${script}` }] as never,
      actionTimeline: [{ error: password }] as never,
      timeoutMs: 30_000,
    });
    const text = JSON.stringify(snapshot);
    for (const value of [session, script, password, framed]) expect(text).not.toContain(value);
    expect(snapshot.visibleText).toContain(decoy);
    expect(snapshot.url).toContain(`${origin}/?echo=`);
  });

  it("keeps cookie and password values out of evaluation results", async () => {
    const { page, cdp } = await open();
    const evaluate = (expression: string) =>
      ServerBrowserPage.evaluate({ page, cdp }, { expression }, 5_000);
    const cookie = JSON.stringify(await evaluate("document.cookie"));
    expect(cookie).not.toContain(script);
    const fields = JSON.stringify(
      await evaluate(
        "({ value: document.querySelector('#pw').value, [document.body.innerText]: [document.title, " +
          JSON.stringify(decoy) +
          "] })",
      ),
    );
    for (const value of [session, script, password]) expect(fields).not.toContain(value);
    expect(fields).toContain(decoy);
    expect(await evaluate("1 + 1")).toBe(2);
    await page.goto(`${origin}/app/`);
    const moved = await evaluate(
      "(() => { const read = document.cookie; history.pushState(null, '', '/'); return read; })()",
    );
    expect(JSON.stringify(moved)).not.toContain(scoped);
  });

  it("masks a cookie the page fetched with before GOAT watched it, under a path no frame showed", async () => {
    await context.addCookies([
      { name: "api", value: fetched, domain: "credentials.test", path: "/api", httpOnly: true },
      // Short and sent only elsewhere: ordinary words that match it stay.
      { name: "seen", value: "yes", domain: "credentials.test", path: "/other" },
    ]);
    // The API echoes the cookie it got; the page puts the answer in its text and its console.
    await context.route(`${origin}/api/**`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ api: fetched }) }),
    );
    const { page, cdp } = await open();
    await page.evaluate(
      "fetch('/api/whoami').then((answer) => answer.text()).then((text) => { document.body.insertAdjacentHTML('beforeend', '<p id=\"echo\">yes, ' + text + '</p>'); })",
    );
    await page.locator("#echo").waitFor();
    // Watching starts after the fetch, as for a tab the desktop already had open.
    const diagnostics = new ServerBrowserDiagnostics(page);
    using _diagnostics = { [Symbol.dispose]: diagnostics.dispose };
    await page.evaluate("console.log(document.getElementById('echo').textContent)");
    const snapshot = await ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      captureImage: false,
      consoleEntries: diagnostics.consoleEntries,
      networkEntries: diagnostics.networkEntries,
      actionTimeline: [],
      timeoutMs: 30_000,
    });
    const read = await ServerBrowserPage.evaluate(
      { page, cdp },
      { expression: "document.body.innerText" },
      5_000,
    );
    const logs = await diagnostics.readMasked({});
    for (const observed of [snapshot, read, logs])
      expect(JSON.stringify(observed)).not.toContain(fetched);
    expect(snapshot.visibleText).toContain('yes, {"api":"');
    expect(JSON.stringify(logs)).toContain("yes, {");
  });
  it("masks only the page's text in console, network and action entries, never their own fields", async () => {
    // Unrelated and never sent to this page, but long enough to be masked anywhere.
    await context.addCookies(
      ["timestamp", "finished", "succeeded"].map((value, index) => ({
        name: `preference${index}`,
        value,
        url: "http://unrelated.test",
      })),
    );
    const { page, cdp } = await open();
    const at = "2026-10-28T00:00:00.000Z";
    const snapshot = await ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      captureImage: false,
      consoleEntries: [{ level: "log", text: `hello ${session}`, timestamp: at }],
      networkEntries: [
        {
          url: `${origin}/${session}`,
          method: "GET",
          status: 200,
          failed: false,
          timestamp: at,
          phase: "finished",
        },
      ],
      actionTimeline: [
        { id: "1", action: "click", status: "succeeded", startedAt: at, error: `saw ${session}` },
      ],
      timeoutMs: 30_000,
    });
    expect(snapshot.consoleEntries[0]).toEqual({
      level: "log",
      text: "hello [redacted]",
      timestamp: at,
    });
    expect(snapshot.networkEntries[0]).toMatchObject({
      url: `${origin}/[redacted]`,
      phase: "finished",
    });
    expect(snapshot.actionTimeline[0]).toMatchObject({
      status: "succeeded",
      error: "saw [redacted]",
    });
  });
});
