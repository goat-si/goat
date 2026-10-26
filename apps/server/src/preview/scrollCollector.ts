/**
 * Scrolls a page like a person would and collects the JSON its own requests return, the way an
 * infinite feed loads more items. It stops at enough items, at a scroll budget, or once the page
 * stops growing.
 *
 * The whole collection is one observation of the tab's control: a secret prompt that opened at
 * any point, even briefly, withholds everything collected, never a partial result.
 *
 * @module scrollCollector
 */
import { BrowserControlInterrupted, type SessionControl } from "./SessionControl.ts";

/** The part of a Playwright response the collector reads. */
export interface CollectorResponse {
  url(): string;
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
  json(): Promise<unknown>;
}

/** The part of a Playwright page the collector drives; a Page satisfies it. */
export interface CollectorPage {
  on(event: "response", listener: (response: CollectorResponse) => void): unknown;
  off(event: "response", listener: (response: CollectorResponse) => void): unknown;
  evaluate(expression: string): Promise<unknown>;
  viewportSize(): { width: number; height: number } | null;
  readonly mouse: {
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  waitForTimeout(timeout: number): Promise<void>;
}

export type ScrollCollectStop = "minItems" | "maxItems" | "maxScrolls" | "noGrowth";

export interface ScrollCollectOptions {
  /** A substring of, or pattern for, the response URL. Every URL matches when absent. */
  readonly url?: string | RegExp;
  /** Matched against the content-type header; JSON types by default. */
  readonly mimeType?: RegExp;
  /** Turns one response's JSON into items; arrays pass through, anything else yields none. */
  readonly extract?: (json: unknown) => ReadonlyArray<unknown>;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly maxScrolls?: number;
  readonly maxResponses?: number;
  readonly maxResponseBytes?: number;
  /** How long a round waits for a matching response after scrolling. */
  readonly settleMs?: number;
  /** How long a round waits for response bodies before it abandons them. */
  readonly bodyTimeoutMs?: number;
}

export interface ScrollCollectResult {
  readonly items: ReadonlyArray<unknown>;
  readonly rounds: number;
  readonly responses: number;
  readonly stoppedBecause: ScrollCollectStop;
}

const JSON_MIME = /^application\/json\s*(;|$)|\+json\s*(;|$)/i;
const MAX_PENDING_BODIES = 16;
const HEIGHT_SCRIPT = "document.scrollingElement ? document.scrollingElement.scrollHeight : 0";

const wentPrivate = () =>
  new BrowserControlInterrupted(
    "This tab went private while collecting, so nothing it collected is returned.",
    "privateMode",
  );

const bounded = (value: number | undefined, fallback: number, low: number, high: number) =>
  value !== undefined && Number.isFinite(value)
    ? Math.min(high, Math.max(low, Math.round(value)))
    : fallback;

const anArray = (json: unknown): ReadonlyArray<unknown> => (Array.isArray(json) ? json : []);

export const matchesResponse = (
  url: string,
  contentType: string,
  options: Pick<ScrollCollectOptions, "url" | "mimeType">,
) => {
  const pattern = options.url;
  const urlMatches =
    pattern === undefined ||
    (typeof pattern === "string"
      ? url.includes(pattern)
      : new RegExp(pattern.source, pattern.flags).test(url));
  return urlMatches && (options.mimeType ?? JSON_MIME).test(contentType);
};

/**
 * Runs inside `control.observe`: a private tab refuses to start, and a private period that
 * overlapped the collection rejects it with the tab's privateMode interruption. `gate` is the
 * caller's dispatch gate for agent input and runs before every mouse event.
 */
export const collectWhileScrolling = (
  page: CollectorPage,
  control: Pick<SessionControl, "observe" | "isPrivate">,
  gate: () => void,
  options: ScrollCollectOptions = {},
) => control.observe(() => collect(page, control, gate, options));

const collect = async (
  page: CollectorPage,
  control: Pick<SessionControl, "isPrivate">,
  gate: () => void,
  options: ScrollCollectOptions,
): Promise<ScrollCollectResult> => {
  const minItems =
    options.minItems === undefined
      ? Number.POSITIVE_INFINITY
      : bounded(options.minItems, 1, 1, 5_000);
  const maxItems = bounded(options.maxItems, 1_000, 1, 5_000);
  const maxScrolls = bounded(options.maxScrolls, 10, 0, 50);
  const maxResponses = bounded(options.maxResponses, 100, 1, 500);
  const maxResponseBytes = bounded(options.maxResponseBytes, 2_000_000, 1, 10_000_000);
  const settleMs = bounded(options.settleMs, 800, 0, 10_000);
  const bodyTimeoutMs = bounded(options.bodyTimeoutMs, 5_000, 0, 30_000);
  const extract = options.extract ?? anArray;
  const dispatch = () => {
    if (control.isPrivate) throw wentPrivate();
    gate();
  };

  const items: Array<unknown> = [];
  const pending = new Set<Promise<void>>();
  /** Reads that outlived a deadline; later rounds stop waiting on them. */
  const abandoned = new Set<Promise<void>>();
  const parsed: Array<unknown> = [];
  let responses = 0;
  let closed = false;
  let arrived: (() => void) | undefined;

  const read = async (response: CollectorResponse) => {
    if (Number(response.headers()["content-length"] ?? 0) > maxResponseBytes) return;
    const body = await response.body();
    if (closed || body.byteLength > maxResponseBytes) return;
    // Playwright caches the body it just returned, so this parses without a second fetch.
    const json = await response.json();
    if (!closed) parsed.push(json);
  };
  const listener = (response: CollectorResponse) => {
    // Nothing a page answers while a person types a secret is collected.
    if (closed || control.isPrivate) return;
    if (responses >= maxResponses || pending.size >= MAX_PENDING_BODIES) return;
    if (!matchesResponse(response.url(), response.headers()["content-type"] ?? "", options)) return;
    responses += 1;
    const work = read(response).catch(() => undefined);
    pending.add(work);
    void work.then(() => {
      pending.delete(work);
      abandoned.delete(work);
    });
    arrived?.();
  };
  // A body that never finishes must not hold the collection open, so each wait has a deadline.
  // An abandoned body keeps its slot until it settles, so outstanding reads never pass the cap.
  const drain = async () => {
    const waiting = [...pending].filter((work) => !abandoned.has(work));
    if (waiting.length > 0) {
      await Promise.race([Promise.allSettled(waiting), page.waitForTimeout(bodyTimeoutMs)]);
      for (const work of waiting) if (pending.has(work)) abandoned.add(work);
    }
    for (const json of parsed.splice(0)) {
      for (const item of extract(json)) {
        if (items.length >= maxItems) return;
        items.push(item);
      }
    }
  };
  // Armed before the scroll, so a response that answers the wheel at once still ends the wait.
  const arm = () =>
    new Promise<void>((resolve) => {
      arrived = resolve;
    });
  const settle = async (next: Promise<void>) => {
    try {
      await Promise.race([next, page.waitForTimeout(settleMs)]);
    } finally {
      arrived = undefined;
    }
  };

  page.on("response", listener);
  try {
    let rounds = 0;
    let lastHeight: number | undefined;
    let unchanged = 0;
    let lastCount = 0;
    for (;;) {
      await drain();
      if (control.isPrivate) throw wentPrivate();
      if (items.length >= maxItems) return { items, rounds, responses, stoppedBecause: "maxItems" };
      if (items.length >= minItems) return { items, rounds, responses, stoppedBecause: "minItems" };
      if (rounds >= maxScrolls) return { items, rounds, responses, stoppedBecause: "maxScrolls" };
      const height = Number(await page.evaluate(HEIGHT_SCRIPT));
      // A feed that scrolls inside its own container keeps the document's height; new items count.
      unchanged = height === lastHeight && items.length === lastCount ? unchanged + 1 : 0;
      lastHeight = height;
      lastCount = items.length;
      if (unchanged >= 2) return { items, rounds, responses, stoppedBecause: "noGrowth" };
      const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
      const next = arm();
      dispatch();
      await page.mouse.move(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2));
      dispatch();
      await page.mouse.wheel(0, Math.floor(viewport.height * 0.9));
      rounds += 1;
      await settle(next);
    }
  } finally {
    closed = true;
    page.off("response", listener);
  }
};
