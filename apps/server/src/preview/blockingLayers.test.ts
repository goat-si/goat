import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  describeLayers,
  layersHeader,
  pickBlocking,
  type LayerCandidate,
  type LayersReport,
} from "./blockingLayers.ts";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import { SessionControl } from "./SessionControl.ts";

const candidate = (overrides: Partial<LayerCandidate>): LayerCandidate => ({
  tagName: "div",
  role: "",
  name: "",
  coverage: 0.9,
  position: "fixed",
  pointerEvents: "auto",
  zIndex: "10",
  ariaModal: false,
  overContent: true,
  mainContent: false,
  empty: false,
  edge: "",
  consent: false,
  selectorHint: "div",
  ...overrides,
});

describe("pickBlocking", () => {
  it("blocks only for a layer over at least 60% of the viewport that takes input", () => {
    expect(pickBlocking([candidate({ coverage: 0.56 })])).toBeNull();
    expect(pickBlocking([candidate({ pointerEvents: "none" })])).toBeNull();
    expect(pickBlocking([candidate({ coverage: 0.6 })])?.coverage).toBe(0.6);
  });

  it("never treats page content or an app shell with nothing beneath it as an overlay", () => {
    expect(pickBlocking([candidate({ tagName: "body", mainContent: true })])).toBeNull();
    expect(pickBlocking([candidate({ overContent: false })])).toBeNull();
    expect(pickBlocking([candidate({ position: "absolute", zIndex: "auto" })])).toBeNull();
    expect(pickBlocking([candidate({ position: "absolute", zIndex: "5" })])).not.toBeNull();
  });

  it("always blocks for a modal dialog, and picks the widest blocking layer", () => {
    const dialog = candidate({
      role: "dialog",
      position: "static",
      overContent: false,
      coverage: 0.7,
    });
    const banner = candidate({ coverage: 0.8, selectorHint: "#banner" });
    expect(pickBlocking([dialog])).toBe(dialog);
    expect(pickBlocking([candidate({ ariaModal: true, position: "relative" })])).not.toBeNull();
    expect(pickBlocking([dialog, banner])).toBe(banner);
  });

  it("blocks for a scrim over blank page and names the small modal on it", () => {
    const scrim = candidate({ coverage: 0.88, overContent: false, empty: true, zIndex: "50" });
    const modal = candidate({ role: "dialog", ariaModal: true, coverage: 0.12, name: "Signup" });
    expect(pickBlocking([scrim])).toBe(scrim);
    expect(pickBlocking([scrim, modal])).toBe(modal);
    expect(pickBlocking([candidate({ role: "dialog", coverage: 0.12 })])).toBeNull();
    expect(
      pickBlocking([candidate({ overContent: false, empty: true, zIndex: "auto" })]),
    ).toBeNull();
  });

  it("blocks for a consent bar on an edge, never for a docked header or toolbar", () => {
    const bar = { coverage: 0.1, overContent: false, edge: "bottom" } as const;
    expect(pickBlocking([candidate({ ...bar, consent: true })])).not.toBeNull();
    expect(pickBlocking([candidate({ ...bar, edge: "right", role: "dialog" })])).not.toBeNull();
    expect(pickBlocking([candidate({ ...bar, edge: "top", role: "banner" })])).toBeNull();
    expect(pickBlocking([candidate({ ...bar, role: "navigation" })])).toBeNull();
    expect(pickBlocking([candidate({ ...bar, edge: "", consent: true })])).toBeNull();
  });
});

describe("layersHeader", () => {
  const report = (blocking: LayerCandidate | null): LayersReport => ({
    blocking,
    candidates: [],
    viewport: { width: 1280, height: 800 },
  });

  it("names the blocking layer in one line an agent can act on", () => {
    expect(layersHeader(report(null))).toBe("@layers none");
    const header = layersHeader(
      report(
        candidate({
          role: "dialog",
          name: `Accept  "all"\n cookies ${"x".repeat(100)}`,
          coverage: 0.84,
          selectorHint: "#consent",
        }),
      ),
    );
    expect(header).toMatch(
      /^@layers blocking=dialog "Accept 'all' cookies x+" coverage=84% hint=#consent$/,
    );
    expect(header.split('"')[1]).toHaveLength(80);
    expect(
      layersHeader(
        report(candidate({ role: "region", name: "Cookies", coverage: 0.1, edge: "bottom" })),
      ),
    ).toBe('@layers blocking=region "Cookies" coverage=10% edge=bottom hint=div');
    const hostile = layersHeader(report(candidate({ role: "dialog\nx", selectorHint: "#a\nb" })));
    expect(hostile.split("\n")).toHaveLength(1);
  });
});

describe.skipIf(!chromiumInstalled)("describeLayers in a browser", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  const control = new SessionControl("agent");

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    page = await context.newPage();
  });
  afterEach(async () => {
    await context.close();
  });

  const article = "<main><h1>Article</h1>" + "<p>Body text.</p>".repeat(40) + "</main>";
  const layers = async (html: string) => {
    await page.setContent(html);
    return describeLayers(page, control);
  };

  it("reports a cookie wall that covers the page", async () => {
    const report = await layers(
      article +
        '<div role="dialog" aria-modal="true" aria-label="Cookie consent" id="consent" style="position:fixed;inset:0;background:#fff"><button>Accept</button></div>',
    );
    expect(report.blocking).toMatchObject({
      role: "dialog",
      name: "Cookie consent",
      selectorHint: "#consent",
    });
    expect(report.blocking?.coverage).toBeGreaterThanOrEqual(0.6);
    expect(layersHeader(report)).toMatch(
      /^@layers blocking=dialog "Cookie consent" coverage=\d+% hint=#consent$/,
    );
  });

  it("reports a native modal dialog and a full-screen popover, and not a small popover menu", async () => {
    await page.setContent(
      article + '<dialog id="confirm"><h2>Delete this draft?</h2><button>Delete</button></dialog>',
    );
    await page.evaluate("document.getElementById('confirm').showModal()");
    const modal = await describeLayers(page, control);
    expect(modal.blocking).toMatchObject({
      role: "dialog",
      name: "Delete this draft?",
      selectorHint: "#confirm",
    });

    await page.setContent(
      article +
        '<div popover id="promo" style="inset:0;width:100vw;height:100vh;margin:0;border:0;background:#fff"><h2>Subscribe for more</h2></div>',
    );
    await page.evaluate("document.getElementById('promo').showPopover()");
    expect((await describeLayers(page, control)).blocking).toMatchObject({
      name: "Subscribe for more",
      selectorHint: "#promo",
    });

    await page.setContent(
      article +
        '<div popover id="gate" style="position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;border:0"><section style="width:100%;height:100%;background:#fff">Members only</section></div>',
    );
    await page.evaluate("document.getElementById('gate').showPopover()");
    expect((await describeLayers(page, control)).blocking).toMatchObject({ selectorHint: "#gate" });

    await page.setContent(
      article +
        '<div popover id="menu" style="width:160px;height:120px"><button>Copy</button></div>',
    );
    await page.evaluate("document.getElementById('menu').showPopover()");
    expect((await describeLayers(page, control)).blocking).toBeNull();
  });

  it("scales a nested frame's modal by what its ancestors leave visible, and skips one off screen", async () => {
    const wall =
      '<div role="dialog" aria-modal="true" aria-label="Framed wall" style="position:fixed;inset:0;background:#fff">Sign in</div>';
    await page.route("https://layers.test/inner", (route) =>
      route.fulfill({ contentType: "text/html", body: wall }),
    );
    await page.route("https://layers.test/outer", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<body style="margin:0"><iframe src="https://layers.test/inner" style="border:0;width:800px;height:800px"></iframe></body>',
      }),
    );
    const framed = async (style: string, wrapper = "") => {
      await page.route("https://layers.test/", (route) =>
        route.fulfill({
          contentType: "text/html",
          body:
            article +
            `<div style="${wrapper}"><iframe id="outer" src="https://layers.test/outer" style="position:absolute;border:0;${style}"></iframe></div>`,
        }),
      );
      await page.goto("https://layers.test/");
      await page
        .frameLocator("#outer")
        .frameLocator("iframe")
        .getByText("Sign in")
        .waitFor({ state: "attached" });
      await page.unroute("https://layers.test/");
      return describeLayers(page, control);
    };
    const clipped = await framed("left:0;top:0;width:100px;height:100px");
    expect(clipped.blocking?.name).toBe("Framed wall");
    // 100 x 100 of a 1000 x 800 viewport, though the inner frame itself is 800 x 800.
    expect(clipped.blocking?.coverage).toBeLessThan(0.02);
    expect((await framed("left:-2000px;top:0;width:100px;height:100px")).blocking).toBeNull();
    // A full-size frame inside a zero-size box that clips its overflow shows nothing.
    const hidden = "position:absolute;top:0;left:0;width:0;height:0;overflow:hidden";
    expect((await framed("left:0;top:0;width:900px;height:700px", hidden)).blocking).toBeNull();
  });

  it("names a consent wall whose message lives in a cross-origin frame by that frame's title", async () => {
    const report = await layers(
      article +
        '<div role="dialog" id="sp_message_container" style="position:fixed;inset:0;z-index:9"><iframe title="Site consent message" src="about:blank" style="width:100%;height:100%;border:0"></iframe></div>',
    );
    expect(report.blocking).toMatchObject({ role: "dialog", name: "Site consent message" });
  });

  it("finds an overlay that lives inside an open shadow root", async () => {
    await page.setContent(article + '<x-wall id="host"></x-wall>');
    await page.evaluate(`
      const root = document.getElementById("host").attachShadow({ mode: "open" });
      root.innerHTML = '<div id="wall" style="position:fixed;inset:0;z-index:9;background:#fff"><h2>Sign in to continue</h2></div>';
    `);
    const report = await describeLayers(page, control);
    expect(report.blocking).toMatchObject({ name: "Sign in to continue", selectorHint: "#wall" });
  });

  it("counts an overlay made of panels as one layer", async () => {
    const report = await layers(
      article +
        '<div id="overlay" style="position:fixed;inset:0;z-index:5"><div style="position:absolute;z-index:1;left:0;top:0;width:50%;height:100%;background:#eee">Left</div><div style="position:absolute;z-index:1;right:0;top:0;width:50%;height:100%;background:#ddd">Right</div></div>',
    );
    expect(report.blocking?.selectorHint).toBe("#overlay");
  });

  it("reports the overlay, not the app root around it", async () => {
    const report = await layers(
      '<div id="app" style="position:absolute;inset:0">' +
        article +
        '<div id="paywall" style="position:fixed;inset:0;z-index:5;background:#fff"><h2>Subscribe</h2></div></div>',
    );
    expect(report.blocking?.selectorHint).toBe("#paywall");
  });

  it("does not flag an app shell or an absolute app root as blocking", async () => {
    const shell = await layers(
      '<div id="shell" style="position:fixed;inset:0">' + article + "</div>",
    );
    expect(layersHeader(shell)).toBe("@layers none");
    const root = await layers(
      '<div id="root" style="position:absolute;inset:0">' + article + "</div>",
    );
    expect(layersHeader(root)).toBe("@layers none");
  });

  it("reports a dialog inside a click-through wrapper, not the wrapper", async () => {
    const report = await layers(
      article +
        '<div id="portal" style="position:fixed;inset:0;z-index:5;pointer-events:none"><div role="dialog" aria-label="Verify age" id="age" style="position:absolute;inset:0;z-index:1;pointer-events:auto;background:#fff">Are you 18?</div></div>',
    );
    expect(report.blocking).toMatchObject({ role: "dialog", selectorHint: "#age" });
  });

  it("ignores a decorative overlay that lets clicks through", async () => {
    const report = await layers(
      article +
        '<div style="position:fixed;inset:0;z-index:5;pointer-events:none;background:rgba(0,0,0,.1)"></div>',
    );
    expect(report.blocking).toBeNull();
  });

  it("reports a small modal over a scrim with only blank page beneath", async () => {
    const report = await layers(
      "<p>Short page.</p>" +
        '<div class="backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:50"></div>' +
        '<div id="signup" role="dialog" aria-modal="true" aria-label="Newsletter signup" style="position:fixed;top:20%;left:25%;width:50%;height:20%;background:#fff;z-index:51"><button>Close</button></div>',
    );
    expect(report.blocking).toMatchObject({ name: "Newsletter signup", selectorHint: "#signup" });
  });

  it("reports a small modal a wrapper or button fills, not the child", async () => {
    const report = await layers(
      "<p>Short page.</p>" +
        '<div id="confirm" role="alertdialog" aria-label="Delete file?" style="position:fixed;top:30%;left:30%;width:40%;height:30%;z-index:5">' +
        '<div class="content" style="width:100%;height:100%"><button style="width:100%;height:100%">Delete</button></div></div>',
    );
    expect(report.blocking).toMatchObject({ name: "Delete file?", selectorHint: "#confirm" });
  });

  it("reports a modal inside a same-origin or cross-origin iframe", async () => {
    const modal =
      '<div id="sso" role="dialog" aria-modal="true" aria-label="Sign in" style="position:fixed;inset:20%"><div style="width:100%;height:100%"><button style="width:100%;height:100%">Continue</button></div></div>';
    await context.route("http://frame.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: modal }),
    );
    for (const frame of [`srcdoc='${modal}'`, 'src="http://frame.test/"']) {
      await page.setContent(
        `${article}<iframe ${frame} style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>`,
      );
      await page.frames()[1]?.waitForSelector("#sso");
      const report = await describeLayers(page, control);
      expect(report.blocking).toMatchObject({ name: "Sign in", selectorHint: "iframe #sso" });
    }
  });

  it("does not flag body content, a chat widget or an iframe without a modal", async () => {
    await page.setContent(
      `${article}<iframe srcdoc="<main><p>Embedded article.</p><button>Play</button></main>"></iframe>` +
        '<div role="dialog" aria-label="Chat" style="position:fixed;right:20px;bottom:20px;width:20%;height:15%"><div style="width:100%;height:100%"><button style="width:100%;height:100%">Chat</button></div></div>',
    );
    await page.frames()[1]?.waitForSelector("button");
    expect(layersHeader(await describeLayers(page, control))).toBe("@layers none");
  });

  it("reports a cookie banner docked to the bottom or the side", async () => {
    const bottom = await layers(
      article +
        '<div id="cookies" role="region" aria-label="Cookie consent" style="position:fixed;left:0;right:0;bottom:0;height:10%;background:#222;z-index:60">We use cookies. <button>Accept</button></div>',
    );
    expect(layersHeader(bottom)).toMatch(
      /^@layers blocking=region "Cookie consent" coverage=\d+% edge=bottom hint=#cookies$/,
    );
    const side = await layers(
      article +
        '<aside id="prefs" role="dialog" aria-label="Privacy choices" style="position:fixed;top:0;bottom:0;right:0;width:20%;background:#eee">Choose <button>Save</button></aside>',
    );
    expect(side.blocking).toMatchObject({ edge: "right", selectorHint: "#prefs" });
  });

  it("does not flag a sticky header, a fixed toolbar or a cookie policy link", async () => {
    const report = await layers(
      '<header role="banner" style="position:sticky;top:0;height:10%;background:#fff;z-index:9"><nav>Home <a href="#">Cookie policy</a></nav></header>' +
        article +
        '<div role="toolbar" style="position:fixed;left:0;right:0;bottom:0;height:8%;background:#ddd"><button>Bold</button></div>',
    );
    expect(layersHeader(report)).toBe("@layers none");
  });

  it("refuses to describe a private tab", async () => {
    const privateControl = new SessionControl("agent");
    privateControl.setPrivate(true);
    await page.setContent(article);
    await expect(describeLayers(page, privateControl)).rejects.toMatchObject({
      reason: "privateMode",
    });
  });
});
