import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import {
  collectWhileScrolling,
  matchesResponse,
  type CollectorPage,
  type CollectorResponse,
} from "./scrollCollector.ts";
import { SessionControl } from "./SessionControl.ts";

const response = (
  json: unknown,
  {
    url = "https://feed.example/api/items",
    type = "application/json",
    length = undefined as number | undefined,
  } = {},
) => {
  const body = Buffer.from(JSON.stringify(json));
  return {
    url: () => url,
    headers: () => ({
      "content-type": type,
      ...(length === undefined ? {} : { "content-length": String(length) }),
    }),
    body: vi.fn(async () => body),
    json: async () => json,
  } satisfies CollectorResponse;
};

/** A body that never arrives, like a stalled stream. */
const stalled = (): CollectorResponse => ({
  url: () => "https://feed.example/api/items",
  headers: () => ({ "content-type": "application/json" }),
  body: () => new Promise<Buffer>(() => undefined),
  json: () => new Promise<unknown>(() => undefined),
});

/**
 * A page whose wheel runs the test's script for that scroll. Deadlines either never fire (every
 * round is answered by a response) or fire at once (to prove a round never waits on a body).
 */
const fakePage = (
  onWheel: (scroll: number, emit: (response: CollectorResponse) => void) => void,
  { deadlines = "never" as "never" | "immediate", grow = true } = {},
) => {
  const listeners = new Set<(response: CollectorResponse) => void>();
  let height = 1_000;
  let scrolls = 0;
  const page = {
    on: (_event: "response", listener: (response: CollectorResponse) => void) =>
      listeners.add(listener),
    off: (_event: "response", listener: (response: CollectorResponse) => void) =>
      listeners.delete(listener),
    evaluate: async () => height,
    viewportSize: () => ({ width: 1_000, height: 800 }),
    mouse: {
      move: vi.fn(async () => undefined),
      wheel: vi.fn(async () => {
        scrolls += 1;
        if (grow) height += 800;
        onWheel(scrolls, (emitted) => {
          for (const listener of listeners) listener(emitted);
        });
      }),
    },
    waitForTimeout: () =>
      deadlines === "immediate" ? Promise.resolve() : new Promise<void>(() => undefined),
  } satisfies CollectorPage;
  return { page, listeners };
};

const open = () => undefined;
const pageOf = (scroll: number) => [scroll * 2 - 2, scroll * 2 - 1];

describe("matchesResponse", () => {
  it("matches JSON by default and narrows by URL substring or pattern", () => {
    expect(matchesResponse("https://x/api", "application/json; charset=utf-8", {})).toBe(true);
    expect(matchesResponse("https://x/api", "application/ld+json", {})).toBe(true);
    expect(matchesResponse("https://x/api", "text/html", {})).toBe(false);
    expect(matchesResponse("https://x/other", "application/json", { url: "/api" })).toBe(false);
    const sticky = /api/g;
    expect(matchesResponse("https://x/api", "application/json", { url: sticky })).toBe(true);
    expect(matchesResponse("https://x/api", "application/json", { url: sticky })).toBe(true);
  });
});

describe("collectWhileScrolling", () => {
  it("collects page after page until it has enough items", async () => {
    const { page, listeners } = fakePage((scroll, emit) => emit(response(pageOf(scroll))));
    const result = await collectWhileScrolling(page, new SessionControl("agent"), open, {
      minItems: 5,
    });
    expect(result).toEqual({
      items: [0, 1, 2, 3, 4, 5],
      rounds: 3,
      responses: 3,
      stoppedBecause: "minItems",
    });
    expect(listeners.size).toBe(0);
  });

  it("stops at the item cap, the scroll budget, or a page that stopped growing", async () => {
    const capped = fakePage((scroll, emit) => emit(response(pageOf(scroll))));
    expect(
      await collectWhileScrolling(capped.page, new SessionControl("agent"), open, { maxItems: 3 }),
    ).toMatchObject({ items: [0, 1, 2], stoppedBecause: "maxItems" });

    const budget = fakePage((scroll, emit) => emit(response(pageOf(scroll))));
    expect(
      await collectWhileScrolling(budget.page, new SessionControl("agent"), open, {
        maxScrolls: 2,
      }),
    ).toMatchObject({ items: [0, 1, 2, 3], rounds: 2, stoppedBecause: "maxScrolls" });

    const flat = fakePage(() => undefined, { deadlines: "immediate", grow: false });
    expect(await collectWhileScrolling(flat.page, new SessionControl("agent"), open)).toMatchObject(
      {
        items: [],
        rounds: 2,
        stoppedBecause: "noGrowth",
      },
    );
  });

  it("ignores other requests, oversized bodies and responses past the budget", async () => {
    const huge = response([99], { length: 50 });
    const { page } = fakePage(
      (scroll, emit) => {
        emit(response(["other"], { url: "https://feed.example/ads" }));
        emit(response(["html"], { type: "text/html" }));
        emit(huge);
        emit(response(pageOf(scroll)));
      },
      { deadlines: "immediate" },
    );
    const result = await collectWhileScrolling(page, new SessionControl("agent"), open, {
      url: "/api/items",
      maxScrolls: 3,
      maxResponses: 3,
      maxResponseBytes: 20,
    });
    // The oversized body counts against the budget but is never read.
    expect(huge.body).not.toHaveBeenCalled();
    expect(result).toMatchObject({ items: [0, 1], responses: 3, stoppedBecause: "maxScrolls" });
  });

  it("never waits on a stalled body, and stalled bodies never pile up past the cap", async () => {
    const bodies = vi.fn(stalled);
    const { page, listeners } = fakePage(
      (_scroll, emit) => {
        for (let index = 0; index < 20; index++) emit(bodies());
      },
      { deadlines: "immediate", grow: false },
    );
    const result = await collectWhileScrolling(page, new SessionControl("agent"), open);
    expect(result).toMatchObject({ items: [], responses: 16, stoppedBecause: "noGrowth" });
    expect(listeners.size).toBe(0);
  });

  it("refuses a private tab and sends it no input", async () => {
    const control = new SessionControl("agent");
    control.setPrivate(true);
    const { page } = fakePage(() => undefined);
    await expect(collectWhileScrolling(page, control, open)).rejects.toMatchObject({
      reason: "privateMode",
    });
    expect(page.mouse.move).not.toHaveBeenCalled();
  });

  it("returns nothing once the tab went private, even if it is public again by the end", async () => {
    const control = new SessionControl("agent");
    const going = fakePage((scroll, emit) => {
      emit(response(pageOf(scroll)));
      if (scroll === 1) control.setPrivate(true);
    });
    await expect(collectWhileScrolling(going.page, control, open)).rejects.toMatchObject({
      reason: "privateMode",
    });
    expect(going.page.mouse.wheel).toHaveBeenCalledTimes(1);
    expect(going.listeners.size).toBe(0);

    const brief = new SessionControl("agent");
    const passing = fakePage((scroll, emit) => {
      if (scroll === 1) {
        brief.setPrivate(true);
        brief.setPrivate(false);
      }
      emit(response(pageOf(scroll)));
    });
    await expect(
      collectWhileScrolling(passing.page, brief, open, { minItems: 4 }),
    ).rejects.toMatchObject({
      reason: "privateMode",
    });
  });

  it("stops at the dispatch gate and cleans up", async () => {
    let calls = 0;
    const gate = () => {
      calls += 1;
      if (calls === 3) throw new Error("agent stopped");
    };
    const { page, listeners } = fakePage((scroll, emit) => emit(response(pageOf(scroll))));
    await expect(collectWhileScrolling(page, new SessionControl("agent"), gate)).rejects.toThrow(
      "agent stopped",
    );
    expect(page.mouse.wheel).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});

describe.skipIf(!chromiumInstalled)("collectWhileScrolling in a browser", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  const FEED = `<body style="margin:0"><div id="list"></div><div id="spacer" style="height:3000px"></div>
<script>
  let requested = 0;
  let loading = false;
  const spacer = document.getElementById("spacer");
  addEventListener("scroll", () => {
    if (requested >= 3) return;
    spacer.style.height = spacer.offsetHeight + 1000 + "px";
    if (loading) return;
    loading = true;
    requested += 1;
    fetch("/api/items?page=" + requested)
      .then((response) => response.json())
      .then((items) => document.getElementById("list").append(items.join(",")))
      .finally(() => { loading = false; });
  });
</script></body>`;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    page = await context.newPage();
    await page.route("https://feed.example/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/api/items")
        return route.fulfill({ contentType: "text/html", body: FEED });
      const index = Number(url.searchParams.get("page"));
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([index * 3 - 2, index * 3 - 1, index * 3]),
      });
    });
    await page.goto("https://feed.example/");
  });
  afterEach(async () => {
    await context.close();
  });

  it("scrolls a feed and returns the items its own requests loaded, in order", async () => {
    const result = await collectWhileScrolling(page, new SessionControl("agent"), open, {
      url: "/api/items",
      minItems: 9,
      // Watchdogs only: every round ends on the feed's response and its settled body.
      settleMs: 10_000,
      bodyTimeoutMs: 30_000,
    });
    expect(result.items).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.stoppedBecause).toBe("minItems");
    expect(result.responses).toBe(3);
  });
});
