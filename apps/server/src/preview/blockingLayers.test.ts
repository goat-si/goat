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

  it("ignores a decorative overlay that lets clicks through", async () => {
    const report = await layers(
      article +
        '<div style="position:fixed;inset:0;z-index:5;pointer-events:none;background:rgba(0,0,0,.1)"></div>',
    );
    expect(report.blocking).toBeNull();
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
