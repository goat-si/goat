// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.

import {
  type PreviewAutomationClickInput,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationDragInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationHoverInput,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationPressInput,
  type PreviewAutomationReloadInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSelectInput,
  type PreviewAutomationSelectResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationSnapshotInput,
  type PreviewAutomationTypeInput,
  type PreviewAutomationWaitForInput,
} from "@goat/contracts";
import { constVoid } from "effect/Function";
import * as NodeCrypto from "node:crypto";
import type { CDPSession, ConsoleMessage, Frame, Locator, Page } from "playwright-core";
import { pointerInterception } from "./pointerInterception.ts";
import { describeReceiver } from "./pointerReceiver.ts";
import {
  actionDeadline,
  pinTarget,
  remaining,
  revealFramesOf,
  waitUntilSelectable,
  waitUntilWritable,
  type Readiness,
} from "./actionReadiness.ts";
import { withRefAnnotations } from "./annotateRefs.ts";
import { resolvePageScope, scopeHidden } from "./pageScope.ts";
import {
  narrowTree,
  resetSnapshotDiff,
  snapshotOptionsResult,
  snapshotPageMetadata,
} from "./snapshotOptions.ts";
import { readLayersHeader } from "./blockingLayers.ts";
import {
  frameUrls,
  maskSecrets,
  maskSnapshotRecords,
  maskTree,
  redactValue,
  tabCookies,
  openReaders,
  dottedPattern,
} from "./pageSecrets.ts";
import { documentPlacement, screenTree, viewportPlacement } from "./ServerBrowserScreen.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

const MAX_EVALUATION_BYTES = 64_000;
const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_SCREENSHOT_WIDTH = 1280;
const MAX_FULL_PAGE_WIDTH = 3840;
const MAX_FULL_PAGE_HEIGHT = 16_384;
const MAX_FULL_PAGE_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const DIAGNOSTIC_BUFFER_LIMIT = 200;

export { ServerBrowserOperationError } from "./browserOperationError.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";

export const toOperationError = (
  cause: unknown,
  timeoutMs?: number,
): ServerBrowserOperationError => {
  if (cause instanceof BrowserControlInterrupted)
    return new ServerBrowserOperationError(
      "PreviewAutomationControlInterruptedError",
      cause.message,
      cause.beforeInput ? { reason: cause.reason, beforeInput: true } : cause.reason,
    );
  if (cause instanceof ServerBrowserOperationError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  const firstLine = message.split("\n")[0] ?? message;
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return new ServerBrowserOperationError("PreviewAutomationTimeoutError", firstLine, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(pointerInterception(message) ? { interceptedBy: pointerInterception(message) } : {}),
    });
  }
  if (
    /while parsing selector|Unknown engine|Unexpected token|strict mode violation/i.test(message)
  ) {
    return new ServerBrowserOperationError("PreviewAutomationInvalidSelectorError", firstLine);
  }
  if (/not an <input>|not editable|not an editable/i.test(message)) {
    return new ServerBrowserOperationError("PreviewAutomationTargetNotEditableError", firstLine);
  }
  return new ServerBrowserOperationError("PreviewAutomationExecutionError", firstLine);
};

export const DEFAULT_TIMEOUT_MS = 15_000;

/** An intercepted click also names what now covers its target; other failures pass unchanged. */
const withReceiver = async (
  page: Page,
  locator: Locator | null,
  cause: unknown,
  deadline: number,
) => {
  const intercepted =
    cause instanceof Error && cause.name === "TimeoutError"
      ? pointerInterception(cause.message)
      : undefined;
  if (locator === null || intercepted === undefined) return cause;
  const error = toOperationError(cause);
  const receiver = await describeReceiver(page, locator, deadline);
  if (receiver === undefined) return error;
  return new ServerBrowserOperationError(error.tag, error.message, {
    ...(typeof error.detail === "object" ? error.detail : {}),
    interceptedBy: `${intercepted} Now at the target: ${receiver}.`.slice(0, 300),
  });
};

/** Real Chromium history, including same-document entries whose response is null. */
export const navigateHistory = async (
  page: Page,
  cdp: CDPSession,
  operation: "back" | "forward" | "reload",
  input: PreviewAutomationReloadInput,
  timeout: number,
  assertControl: () => void,
) => {
  const options = {
    timeout: input.timeoutMs ?? timeout,
    waitUntil:
      input.readiness === "domContentLoaded" ? ("domcontentloaded" as const) : ("load" as const),
  };
  if (operation === "reload" && input.ignoreCache !== true) {
    assertControl();
    invalidateRefs(page);
    await page.reload(options);
    return;
  }
  let entryId: number | undefined;
  if (operation !== "reload") {
    const history = await cdp.send("Page.getNavigationHistory");
    const index = history.currentIndex + (operation === "back" ? -1 : 1);
    entryId = history.entries[index]?.id;
    if (entryId === undefined) {
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        `No ${operation} history entry exists for this browser tab.`,
      );
    }
  }
  assertControl();
  invalidateRefs(page);
  // Install the waiter before sending CDP: an acknowledgement alone does not
  // prove that Electron's guest page actually committed a navigation.
  await Promise.all([
    page.waitForNavigation(options),
    operation === "reload"
      ? cdp.send("Page.reload", { ignoreCache: true })
      : cdp.send("Page.navigateToHistoryEntry", { entryId: entryId! }),
  ]);
};

const pageRefs = new WeakMap<Page, { generation: string; refs: Map<string, string> }>();
// A compact runtime namespace prevents old refs from aliasing after a server restart.
const refNamespace = NodeCrypto.randomUUID().slice(0, 8);
let snapshotSequence = 0;
const nextRefGeneration = () => `${refNamespace}-${(++snapshotSequence).toString(36)}`;

/** A takeover revokes previously issued refs even when the document stays unchanged. */
export const invalidateRefs = (page: Page, preserveDiff = false) => {
  if (!preserveDiff) resetSnapshotDiff(page);
  const state = pageRefs.get(page);
  if (state) {
    state.generation = nextRefGeneration();
    state.refs.clear();
  }
};

const refsFor = (page: Page) => {
  let state = pageRefs.get(page);
  if (!state) {
    state = { generation: nextRefGeneration(), refs: new Map<string, string>() };
    pageRefs.set(page, state);
    page.on("framenavigated", () => invalidateRefs(page));
    page.on("framedetached", () => invalidateRefs(page));
  }
  return state;
};

export const targetLocator = (
  page: Page,
  input: { readonly locator?: string | undefined; readonly selector?: string | undefined },
): Locator | null => {
  const selector = input.locator ?? input.selector;
  if (selector === undefined) return null;
  const engines = selector.replace(
    /\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    " ",
  );
  // The tree shows a ref bare, so a bare GOAT ref is one; as CSS it would match nothing.
  const bare = /^\s*(t3-\S+-(?:f\d+)?e\d+)\s*$/.exec(selector)?.[1];
  if (bare !== undefined || /(?:^|>>)\s*\*?aria-ref\s*=/.test(engines)) {
    const ref = bare ?? /^\s*aria-ref\s*=\s*(\S+)\s*$/.exec(selector)?.[1];
    const nativeRef = ref === undefined ? undefined : pageRefs.get(page)?.refs.get(ref);
    if (nativeRef === undefined) {
      throw new ServerBrowserOperationError(
        "PreviewAutomationInvalidSelectorError",
        "This element ref is stale or belongs to another tab. Take a fresh snapshot and use its locator.",
        { staleRef: true },
      );
    }
    return page.locator(`aria-ref=${nativeRef}`);
  }
  // Playwright's strict locators reject ambiguous controls rather than acting on row one.
  return page.locator(selector);
};

export type PointerReporter = (
  point: { readonly x: number; readonly y: number },
  phase: "move" | "click",
) => Promise<void>;
const noPointer: PointerReporter = async () => {};

/** A gate rechecks authority after target waits; linger covers input still draining after return. */
export interface DispatchGate {
  (): void;
  readonly linger?: (work: Promise<unknown>) => void;
  /** When the caller stops waiting, on the performance.now() clock; no input goes out after it. */
  readonly deadline?: number;
}
const open: DispatchGate = () => {};

/** How long an action that passed its gate may still wait for Playwright's own checks. */
const DISPATCH_TIMEOUT_MS = 1_000;

const targetChanged = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationExecutionError",
    "The target changed or was disabled before the input landed. Take a fresh snapshot and try again.",
  );

/** The target's element, after Playwright's wait for it; a detached target is a changed one. */
export const elementOf = async (locator: Locator, timeout: number) => {
  const handle = await locator.elementHandle({ timeout });
  if (handle === null) throw targetChanged();
  return handle;
};

/** A wait for the target that timed out sent nothing, so the broker can report it unsent. */
const unsentOnTimeout = (cause: unknown) =>
  cause instanceof Error && cause.name === "TimeoutError"
    ? new ServerBrowserOperationError(
        "PreviewAutomationTimeoutError",
        "The target was not found or not ready before the deadline, so no input was sent.",
        { beforeInput: true },
      )
    : cause;

/** Playwright's actionability waits, without the mouse move its trial runs make. */
const settled = async (locator: Locator, deadline: number, enabled = true) => {
  const handle = await elementOf(locator, remaining(deadline)).catch((cause: unknown) => {
    throw unsentOnTimeout(cause);
  });
  try {
    await handle.waitForElementState("visible", { timeout: remaining(deadline) });
    if (enabled) await handle.waitForElementState("enabled", { timeout: remaining(deadline) });
    await handle.waitForElementState("stable", { timeout: remaining(deadline) });
  } catch (cause) {
    throw unsentOnTimeout(cause);
  } finally {
    void handle.dispose().catch(constVoid);
  }
};

/** After the gate: Playwright's own last checks, briefly, and no wait for a navigation. */
const dispatched = { timeout: DISPATCH_TIMEOUT_MS, noWaitAfter: true } as const;

const targetPoint = (
  page: Page,
  locator: Locator | null,
  input: { readonly x?: number | undefined; readonly y?: number | undefined },
  deadline: number,
) =>
  locatePoint(page, locator, input, deadline).catch((cause: unknown) => {
    throw unsentOnTimeout(cause);
  });

const locatePoint = async (
  page: Page,
  locator: Locator | null,
  input: { readonly x?: number | undefined; readonly y?: number | undefined },
  deadline: number,
) => {
  if (locator === null) return { x: input.x ?? 0, y: input.y ?? 0 };
  const target = await elementOf(locator, remaining(deadline));
  try {
    await revealFramesOf(target, deadline);
  } finally {
    void target.dispose().catch(constVoid);
  }
  await locator.scrollIntoViewIfNeeded({ timeout: remaining(deadline) });
  const box = await locator.boundingBox({ timeout: remaining(deadline) });
  if (box) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const viewport = page.viewportSize();
  return { x: (viewport?.width ?? 0) / 2, y: (viewport?.height ?? 0) / 2 };
};

/**
 * A `data:` URL carries its content, which can be a whole file, and URLs and diagnostics
 * reach tool results and provider logs. Keeps only the media type: the payload can hold any
 * character and parameters are page-chosen too.
 */
export const withoutDataPayload = (url: string) => {
  // Read the scheme as a browser would: it ignores leading controls and spaces, and tabs and
  // newlines anywhere. A snapshot's YAML value may be quoted and escaped; an escape that isn't a
  // tab or newline still decodes to something that can't start a scheme.
  const value = url
    .replace(/^["']/, "")
    .replace(/\\(x[\da-f]{2}|u[\da-f]{4}|.)/gi, (_escape, code: string) =>
      code.length > 1
        ? String.fromCharCode(Number.parseInt(code.slice(1), 16))
        : ({ t: "\t", n: "\n", r: "\r", '"': '"', "\\": "\\" }[code] ?? "\u0001"),
    )
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\u0000-\u0020]+/, "");
  const parsed = /^data:([^,;]*)/i.exec(value);
  if (!parsed) return url;
  const type = parsed[1]!.trim();
  const mediaType = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/.test(type) ? type : "";
  return `data:${mediaType},…`;
};

/**
 * Chromium's own console messages, which carry no arguments, quote `data:` URLs whole, as in a
 * blocked navigation or a CSP violation. Everything after the first one goes, since Chromium
 * accepts any type and a payload can hold any character. What a page logs itself is its own
 * text, like anything else it shows, so it stays.
 */
export const consoleText = (message: ConsoleMessage) =>
  message.args().length > 0
    ? message.text()
    : message.text().replace(/(?<![a-z\d])data:[^,;]*[,;][\s\S]*/i, withoutDataPayload);

// Split on LF alone: a value keeps any U+2028 that a multiline regex would treat as a line end.
const withoutTreeDataPayloads = (tree: string) =>
  tree
    .split("\n")
    .map((line) => {
      const url = /^(\s*- \/url: )(.*)$/s.exec(line);
      return url ? url[1] + withoutDataPayload(url[2]!) : line;
    })
    .join("\n");
const pageChanged = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationExecutionError",
    "The page changed while capturing its snapshot. Take another snapshot.",
  );

const tooBusy = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationTimeoutError",
    "The page was too busy to capture a snapshot in time. Wait for it to settle and take another snapshot.",
  );

const VALUE_TOO_LONG = "A password field holds a value too long to hide, so no snapshot was taken.";
const FULL_PAGE_TOO_LARGE =
  "The full-page screenshot exceeds the 3840 × 16384 pixel or 8 MiB limit, even at reduced scale. Use a viewport snapshot instead.";
// A second capture would fail the same way; this one already tried every scale.
const NOT_RETRIED = new Set([VALUE_TOO_LONG, FULL_PAGE_TOO_LARGE]);

/** Chromium sizes the capture, so the reported size is read from the PNG header. */
const pngSize = (base64: string) => {
  const header = Buffer.from(base64.slice(0, 32), "base64");
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
};

/**
 * A page's display ratio and CSS viewport, read in an isolated world since page script can
 * reassign `devicePixelRatio`, `innerWidth`, and `innerHeight` in its own, and its page zoom.
 */
const readPageMetrics = async (cdp: CDPSession) => {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "goat-preview-metrics",
  });
  let { cssVisualViewport } = await cdp.send("Page.getLayoutMetrics");
  // Desktop zoom applies asynchronously; bracket the CSS metrics to reject a torn read.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const zoom = cssVisualViewport.zoom ?? 1;
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: "({ ratio: devicePixelRatio, width: innerWidth, height: innerHeight })",
      contextId: executionContextId,
      returnByValue: true,
    });
    ({ cssVisualViewport } = await cdp.send("Page.getLayoutMetrics"));
    if ((cssVisualViewport.zoom ?? 1) === zoom) {
      const { ratio, width, height } = result.value as {
        readonly ratio: number;
        readonly width: number;
        readonly height: number;
      };
      return { ratio, width, height, zoom };
    }
  }
  throw new Error(
    "The page's zoom kept changing while the snapshot read its size. Try the snapshot again.",
  );
};

// Never pass a clip scale: Chromium mirrors the top-left of the page into a `backdrop-filter`
// in any capture it shrinks.
export const captureViewport = async (
  cdp: CDPSession,
  options: { readonly format: "png" | "jpeg"; readonly quality?: number },
) => {
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: options.format,
    ...(options.quality === undefined ? {} : { quality: options.quality }),
  });
  return data;
};

/** Runs in the page's own isolated world, as the server has no image library. */
const SHRINK_PNG = `async function (png, width, height) {
  const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  // Namespaced, as an XML document's createElement makes a plain element with no getContext.
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
}`;

const shrinkPng = async (cdp: CDPSession, png: string, scale: number) => {
  const size = pngSize(png);
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "goat-preview-screenshot",
  });
  const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
    functionDeclaration: SHRINK_PNG,
    executionContextId,
    arguments: [
      { value: png },
      { value: Math.round(size.width * scale) },
      { value: Math.round(size.height * scale) },
    ],
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error("The snapshot could not shrink its screenshot.");
  return result.value as string;
};

// Bounds, PNG checks, and scale retries adapted from Emanuele-web04/synara @ 566efb1b1.
// Copyright (c) 2026 Emanuele Di Pietro. MIT license; see the repository LICENSE.
/** Captures at CSS resolution or lower without changing viewport, scroll, or emulation. */
const captureFullPage = async (cdp: CDPSession) => {
  const { cssContentSize } = await cdp.send("Page.getLayoutMetrics");
  if (!Number.isFinite(cssContentSize.width) || !Number.isFinite(cssContentSize.height)) {
    throw new ServerBrowserOperationError(
      "PreviewAutomationExecutionError",
      "The browser did not report valid document dimensions for a full-page screenshot.",
    );
  }
  const width = Math.min(MAX_FULL_PAGE_WIDTH, Math.max(1, Math.ceil(cssContentSize.width)));
  const height = Math.min(MAX_FULL_PAGE_HEIGHT, Math.max(1, Math.ceil(cssContentSize.height)));
  const clipped = width < cssContentSize.width || height < cssContentSize.height;
  // CSS clips and image pixels differ across native and emulated Retina tabs. Bound
  // the actual PNG to the CSS clip so Retina captures cannot exceed CSS resolution.
  for (const scale of [1, 0.75, 0.5, 0.25]) {
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale },
    });
    const byteLength = Buffer.byteLength(data, "base64");
    if (byteLength > MAX_FULL_PAGE_BYTES) continue;
    const header = Buffer.from(data.slice(0, 32), "base64");
    if (
      header.length < 24 ||
      !header.subarray(0, 8).equals(PNG_SIGNATURE) ||
      header.subarray(12, 16).toString("ascii") !== "IHDR"
    ) {
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "The browser returned an invalid full-page PNG. Try another snapshot.",
      );
    }
    const imageWidth = header.readUInt32BE(16);
    const imageHeight = header.readUInt32BE(20);
    if (imageWidth < 1 || imageHeight < 1 || imageWidth > width || imageHeight > height) continue;
    return {
      mimeType: "image/png" as const,
      data,
      width: imageWidth,
      height: imageHeight,
      fullPage: true,
      clipped,
      byteLength,
      ...documentPlacement(width, height, imageWidth),
    };
  }
  throw new ServerBrowserOperationError("PreviewAutomationExecutionError", FULL_PAGE_TOO_LARGE);
};

type SnapshotInput = PreviewAutomationSnapshotInput & {
  readonly agentSessionId?: string | undefined;
  readonly page: Page;
  readonly cdp: CDPSession;
  /** Headless pages render at the scale the server set; a desktop page at its display's. */
  readonly renderScale: number | "display";
  readonly fullPage?: boolean | undefined;
  /** False skips the capture when nothing would show or save the image (L4). */
  readonly captureImage?: boolean;
  readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>;
  readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>;
  readonly actionTimeline: PreviewAutomationSnapshot["actionTimeline"];
  /** The tab's filled-secret mask, run before the text limits cut a value into a start. */
  readonly diagnostics?: { readonly mask: (text: string, limit?: number) => string };
  /** What remains of the request's deadline, the one its timeout error names. */
  readonly timeoutMs: number;
};

/** The scale a page renders at and its viewport in device-independent pixels. */
const renderingOf = async (input: SnapshotInput) => {
  if (input.renderScale !== "display") {
    const viewport = input.page.viewportSize() ?? { width: 1280, height: 800 };
    return { renderScale: input.renderScale, viewport };
  }
  // The display ratio a desktop page reports includes its page zoom, and its sizes are CSS pixels.
  const page = await readPageMetrics(input.cdp);
  return {
    renderScale: page.ratio / page.zoom,
    viewport: {
      width: Math.round(page.width * page.zoom),
      height: Math.round(page.height * page.zoom),
    },
  };
};

const capture = async (
  input: SnapshotInput,
  deadline: number,
): Promise<PreviewAutomationSnapshot> => {
  const { renderScale, viewport } = await renderingOf(input);
  // A late metrics reply must not begin a capture after viewers have resumed.
  if (Date.now() >= deadline) throw tooBusy();
  const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / (viewport.width * renderScale));
  const state = refsFor(input.page);
  const scoped = input.scope ? await resolvePageScope(input.page, input.scope) : undefined;
  invalidateRefs(input.page, true);
  const generation = state.generation;
  const { readers, read } = await openReaders(input.page, input.cdp);
  const before = await read();
  const captureImage = (): Promise<PreviewAutomationSnapshot["screenshot"]> =>
    input.captureImage === false
      ? Promise.resolve(undefined)
      : input.fullPage
        ? captureFullPage(input.cdp)
        : captureViewport(input.cdp, { format: "png" })
            .then((png) => (scale < 1 ? shrinkPng(input.cdp, png, scale) : png))
            .then((data) => ({
              mimeType: "image/png" as const,
              data,
              ...viewportPlacement(viewport, pngSize(data)),
            }));
  // Taken between the reads, so a value that changes during either fails the comparison.
  // Awaited after the tree: a capture that fails has finished its tree before a retry starts.
  const pageAndScreenshot = Promise.all([
    snapshotPageMetadata(input.page, scoped),
    readLayersHeader(input.page),
    input.annotate ? Promise.resolve(undefined) : captureImage(),
    tabCookies(input.page),
  ]);
  void pageAndScreenshot.catch(constVoid);
  let tree: string;
  let screenshot: PreviewAutomationSnapshot["screenshot"];
  let unread: ReadonlyArray<Frame> = [];
  let dotted: ReturnType<typeof dottedPattern>;
  try {
    // Leaves time for the second read; a frame that never loads holds the tree until then.
    tree = await (scoped ?? input.page).ariaSnapshot({
      mode: "ai",
      boxes: true,
      timeout: Math.max(1, deadline - Date.now() - 2_000),
    });
    const image =
      input.annotate && input.captureImage !== false
        ? withRefAnnotations(
            input.page,
            screenTree(tree, {
              limit: MAX_VISIBLE_TEXT_LENGTH,
              unread: [],
              generation,
              refs: new Map(),
            }).accessibilityTree,
            captureImage,
          )
        : Promise.resolve(undefined);
    screenshot = await image;
    const after = await read(before);
    // A value that changed meanwhile may be in the tree under neither reading.
    if (after.some((values, i) => values && JSON.stringify(values) !== JSON.stringify(before[i])))
      throw pageChanged();
    dotted = dottedPattern(after.flatMap((values) => values ?? []));
    // A frame that didn't answer both times, such as one that crashed, can only hold values the
    // tree shows if the tree shows its content.
    unread = readers.flatMap((reader, i) => (after[i] ? [] : reader.frames));
    const filled = /^\s*- iframe (?:\[active\] )?\[ref=(\S+?)\].*:$/gm;
    for (const [, ref] of unread.length ? tree.matchAll(filled) : []) {
      const iframe = await input.page.locator(`aria-ref=${ref}`).elementHandle({ timeout: 2_000 });
      if (!iframe) throw pageChanged();
      const frame = await iframe.contentFrame();
      void iframe.dispose().catch(constVoid);
      if (frame && unread.includes(frame)) throw tooBusy();
    }
  } catch (cause) {
    await pageAndScreenshot.catch(constVoid);
    throw cause;
  }
  const [captured, layersLine, capturedImage, cookies] = await pageAndScreenshot;
  // Checked after the reads: an embedding frame element can be hidden while they run.
  const hidden = scoped ? await scopeHidden(scoped) : false;
  const page = hidden ? { ...captured, visibleText: "" } : captured;
  if (hidden) tree = "";
  screenshot ??= capturedImage;
  if (state.generation !== generation) throw pageChanged();
  const filled = input.diagnostics?.mask ?? ((text: string) => text);
  const secrets = maskSecrets(dotted, cookies);
  const mask = (text: string, limit?: number) => filled(secrets(text), limit).slice(0, limit);
  // Redacted before the cut, so a payload crossing it can't leave its start showing, and before
  // masking, which could hide the `data:` scheme behind a password value's dots.
  const redacted = withoutTreeDataPayloads(tree);
  const narrowed = narrowTree(
    // An interactive-only tree keeps lines from past the cut, so it is masked in full.
    filled(
      maskTree(redacted, dotted, cookies),
      input.interactiveOnly ? undefined : MAX_VISIBLE_TEXT_LENGTH,
    ),
    input.interactiveOnly,
  );
  const { accessibilityTree, ...treeFields } = screenTree(`${mask(layersLine)}\n${narrowed}`, {
    limit: MAX_VISIBLE_TEXT_LENGTH,
    unread,
    generation,
    refs: state.refs,
  });
  return snapshotOptionsResult(
    input.page,
    {
      ...page,
      url: mask(page.url),
      title: mask(page.title),
      // Mask text before truncating so a value crossing the cut cannot leak its prefix.
      visibleText: mask(page.visibleText, MAX_VISIBLE_TEXT_LENGTH),
      accessibilityTree,
      ...treeFields,
      ...maskSnapshotRecords(mask, input),
      ...(screenshot === undefined ? {} : { screenshot }),
    },
    input,
    page.visibleText.length,
    unread.length,
    narrowed.length + layersLine.length + 1,
  );
};

/** Snapshots begun per page; observers' snapshots aren't queued, so two can overlap. */
const snapshotTurns = new WeakMap<Page, number>();

export const snapshot = async (input: SnapshotInput): Promise<PreviewAutomationSnapshot> => {
  const deadline = Date.now() + input.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(tooBusy()), input.timeoutMs);
  });
  const turn = (snapshotTurns.get(input.page) ?? 0) + 1;
  snapshotTurns.set(input.page, turn);
  // Retry only before the deadline and the next snapshot, whose refs a later retry would revoke.
  const captured = capture(input, deadline).catch((cause: unknown) =>
    Date.now() < deadline &&
    snapshotTurns.get(input.page) === turn &&
    !(cause instanceof Error && NOT_RETRIED.has(cause.message))
      ? capture(input, deadline)
      : Promise.reject(cause),
  );
  try {
    return await Promise.race([captured, expired]);
  } catch (cause) {
    throw cause instanceof Error && cause.name === "TimeoutError" ? tooBusy() : cause;
  } finally {
    clearTimeout(timer);
    // CDP cannot cancel a capture: the caller's capture lock and paused screencasts wait for the
    // one Chromium still owes, so no second capture runs beside it. The caller's own deadline
    // answers it meanwhile (CaptureLock).
    await captured.then(constVoid, constVoid);
  }
};

/** Return when a dialog opens; waiting for the action to finish would block until dialog resolution. */
export const click = async (
  page: Page,
  input: PreviewAutomationClickInput,
  pointer: PointerReporter = noPointer,
  gate: DispatchGate = open,
): Promise<{ readonly x: number; readonly y: number }> => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = actionDeadline(timeout, gate.deadline);
  const locator = targetLocator(page, input);
  const point = await targetPoint(page, locator, input, deadline);
  await pointer(point, "click");
  const button = input.button ?? "left";
  if (locator !== null) await settled(locator, deadline);
  let onDialog = constVoid;
  const dialogOpened = new Promise<"dialog">((resolve) => {
    onDialog = () => resolve("dialog");
    page.once("dialog", onDialog);
  });
  // Each press goes out on its own after the gate: Playwright sends a double click's presses
  // together, and the browser still delivers the rest after the first opens a dialog.
  const press = (count: number) => {
    // A later press after the deadline is refused too, but the first one may already have landed.
    if (count === 1) remaining(deadline);
    else if (performance.now() >= deadline)
      throw new ServerBrowserOperationError(
        "PreviewAutomationTimeoutError",
        "The click's deadline passed after its first press; the later presses were not sent.",
      );
    gate();
    if (count === 1)
      return locator === null
        ? page.mouse.click(point.x, point.y, { button })
        : locator.click({ button, ...dispatched });
    return page.mouse
      .down({ button, clickCount: count })
      .then(() => page.mouse.up({ button, clickCount: count }));
  };
  try {
    for (let count = 1; count <= (input.clickCount ?? 1); count++) {
      const pressed = press(count);
      if ((await Promise.race([pressed, dialogOpened])) === "dialog") {
        // That press waits on the dialog, past this action; later presses are never sent.
        gate.linger?.(pressed);
        void pressed.catch(constVoid);
        break;
      }
    }
  } catch (cause) {
    throw await withReceiver(page, locator, cause, deadline);
  } finally {
    page.off("dialog", onDialog);
  }
  return point;
};

export const type = async (
  page: Page,
  input: PreviewAutomationTypeInput,
  gate: DispatchGate = open,
  readiness: Readiness = {},
) => {
  const deadline = actionDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, gate.deadline);
  const locator = targetLocator(page, input);
  // A shadow host also matches :focus; use its innermost focused descendant.
  const target = locator ?? page.locator("*:focus").last();
  const present = locator !== null || (await target.count()) > 0;
  const handle = present ? await pinTarget(target, deadline) : null;
  try {
    if (handle) await waitUntilWritable(handle, deadline, readiness);
    const focused =
      handle !== null &&
      (await handle.evaluate((element, clear) => {
        // Like the desktop host: an enabled text control or contenteditable
        // that actually takes focus. Anything else would swallow the text or
        // send it to whichever field had focus before.
        const control = element as unknown as {
          readonly type?: string;
          readonly disabled?: boolean;
          readonly readOnly?: boolean;
          readonly isContentEditable?: boolean;
          readonly focus?: () => void;
        };
        const nonText = [
          "button",
          "checkbox",
          "color",
          "file",
          "hidden",
          "image",
          "radio",
          "range",
          "reset",
          "submit",
        ];
        const textControl =
          element.tagName === "TEXTAREA" ||
          (element.tagName === "INPUT" && !nonText.includes(control.type ?? "text"));
        if (!(textControl || control.isContentEditable) || control.disabled || control.readOnly) {
          return false;
        }
        control.focus?.();
        const root = element.getRootNode() as { readonly activeElement?: typeof element | null };
        const active = root.activeElement;
        const owned = active != null && (active === element || element.contains(active));
        // Selected here, the old text is replaced by the one input sent after the gate.
        if (owned && clear) {
          if (textControl) (element as unknown as { select(): void }).select();
          else
            (
              globalThis as unknown as {
                getSelection(): { selectAllChildren(node: unknown): void } | null;
              }
            )
              .getSelection()
              ?.selectAllChildren(element);
        }
        return owned;
      }, input.clear === true));
    if (focused !== true) {
      throw new ServerBrowserOperationError(
        "PreviewAutomationTargetNotEditableError",
        "The target is not an enabled text field, so no text was typed.",
      );
    }
    remaining(deadline);
    gate();
    // One input after the gate: a key press is held off by the input fence; inserted text is a
    // single call with nothing to wait for.
    if (input.text === "") {
      if (input.clear) await page.keyboard.press("Delete");
      return;
    }
    await page.keyboard.insertText(input.text);
  } finally {
    void handle?.dispose().catch(constVoid);
  }
};

export const hover = async (
  page: Page,
  input: PreviewAutomationHoverInput,
  pointer: PointerReporter = noPointer,
  gate: DispatchGate = open,
) => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = actionDeadline(timeout, gate.deadline);
  const locator = targetLocator(page, input);
  await pointer(await targetPoint(page, locator, input, deadline), "move");
  if (locator === null) {
    remaining(deadline);
    gate();
    await page.mouse.move(input.x ?? 0, input.y ?? 0);
    return;
  }
  await settled(locator, deadline, false);
  remaining(deadline);
  gate();
  await locator.hover(dispatched);
};

export const select = async (
  page: Page,
  input: PreviewAutomationSelectInput,
  gate: DispatchGate = open,
  readiness: Readiness = {},
): Promise<PreviewAutomationSelectResult> => {
  const deadline = actionDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, gate.deadline);
  const handle = await elementOf(targetLocator(page, input)!, remaining(deadline));
  try {
    const ready = await waitUntilSelectable(handle, input.values, deadline, readiness);
    const found = await handle.evaluate((element) => {
      if (element.tagName !== "SELECT") return null;
      const select = element as unknown as {
        matches(selector: string): boolean;
        readonly multiple: boolean;
        readonly options: ArrayLike<{ value: string; label: string }>;
      };
      return {
        disabled: select.matches(":disabled"),
        multiple: select.multiple,
        options: Array.from(select.options, ({ value, label }) => ({ value, label: label.trim() })),
      };
    });
    if (found === null)
      throw new ServerBrowserOperationError(
        "PreviewAutomationTargetNotEditableError",
        "This element is not a <select>. Click a custom dropdown, then click its option.",
      );
    if (found.disabled && !ready)
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "This <select> stayed disabled until the deadline, so nothing was selected.",
        { beforeInput: true },
      );
    if (found.disabled) throw targetChanged();
    const values = input.values.map(
      (entry) =>
        (
          found.options.find((option) => option.value === entry) ??
          found.options.find((option) => option.label === entry.trim())
        )?.value,
    );
    const missing = values.indexOf(undefined);
    if (missing !== -1 || (!found.multiple && values.length > 1))
      throw new ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        missing !== -1
          ? `This <select> ${ready ? "has" : "still has"} no option "${input.values[missing]}"${ready ? "" : " after waiting for it"}.`
          : "This <select> takes one option.",
        { beforeInput: true },
      );
    remaining(deadline);
    gate();
    // What Playwright's selectOption does once the options exist, without its wait for them.
    const selected = await handle.evaluate((element, chosen) => {
      const select = element as unknown as {
        selectedIndex: number;
        readonly options: ArrayLike<{ value: string; selected: boolean }>;
        readonly selectedOptions: ArrayLike<{ value: string }>;
        dispatchEvent(event: unknown): boolean;
      };
      // No values clears the selection, single select included (selectOption's contract).
      select.selectedIndex = -1;
      for (const value of chosen) {
        const option = Array.from(select.options).find((entry) => entry.value === value);
        if (option) option.selected = true;
      }
      const EventType = (
        globalThis as unknown as { Event: new (type: string, init: object) => unknown }
      ).Event;
      select.dispatchEvent(new EventType("input", { bubbles: true, composed: true }));
      select.dispatchEvent(new EventType("change", { bubbles: true }));
      return Array.from(select.selectedOptions, (option) => option.value);
    }, values as ReadonlyArray<string>);
    return { selected };
  } finally {
    void handle.dispose().catch(constVoid);
  }
};

export const drag = async (
  page: Page,
  input: PreviewAutomationDragInput,
  pointer: PointerReporter = noPointer,
  gate: DispatchGate = open,
) => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = actionDeadline(timeout, gate.deadline);
  const source = targetLocator(page, { locator: input.source })!;
  const target = targetLocator(page, { locator: input.target })!;
  await pointer(await targetPoint(page, source, {}, deadline), "move");
  await settled(source, deadline, false);
  await settled(target, deadline, false);
  const end = await target.boundingBox({ timeout: remaining(deadline) }).catch(() => null);
  if (end) await pointer({ x: end.x + end.width / 2, y: end.y + end.height / 2 }, "move");
  remaining(deadline);
  gate();
  await source.dragTo(target, dispatched);
};

export const press = async (
  page: Page,
  input: PreviewAutomationPressInput,
  gate: DispatchGate = open,
) => {
  gate();
  await page.keyboard.press([...(input.modifiers ?? []), input.key].join("+"));
};

export const scroll = async (
  page: Page,
  input: PreviewAutomationScrollInput,
  gate: DispatchGate = open,
) => {
  const delta = [input.deltaX ?? 0, input.deltaY ?? 0] as const;
  const locator = targetLocator(page, input);
  if (locator === null) {
    gate();
    // Page-side code is passed as source: the server compiles without DOM types.
    await page.evaluate(`scrollBy(${delta[0]}, ${delta[1]})`);
    return;
  }
  const handle = await elementOf(locator, DEFAULT_TIMEOUT_MS);
  try {
    gate();
    await handle.evaluate((element, [x, y]) => element.scrollBy(x, y), delta);
  } finally {
    void handle.dispose().catch(constVoid);
  }
};

/** Masks what an evaluation reads back as a snapshot would, for URLs before and after it ran. */
const redactEvaluation = async (
  page: Page,
  cdp: CDPSession,
  value: unknown,
  before: ReadonlyArray<string>,
) => {
  const [cookies, fields] = await Promise.all([
    tabCookies(page, before),
    openReaders(page, cdp).then(({ read }) => read()),
  ]);
  const values = fields.flat().filter((each) => typeof each === "string");
  return redactValue(value, maskSecrets(dottedPattern(values), cookies));
};

/** Terminate expired page scripts so a hung expression cannot block the tab's control queue. */
export const evaluate = async (
  { page, cdp }: { readonly page: Page; readonly cdp: CDPSession },
  input: PreviewAutomationEvaluateInput,
  timeoutMs: number,
) => {
  const before = frameUrls(page);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Stops a busy script; an awaited promise is abandoned and settles unread.
      void cdp.send("Runtime.terminateExecution").catch(constVoid);
      reject(
        new ServerBrowserOperationError(
          "PreviewAutomationTimeoutError",
          `Evaluation did not finish within ${timeoutMs}ms and was stopped.`,
        ),
      );
    }, timeoutMs);
  });
  const evaluation = cdp.send("Runtime.evaluate", {
    expression: input.expression,
    awaitPromise: input.awaitPromise ?? true,
    returnByValue: input.returnByValue ?? true,
  });
  void evaluation.catch(constVoid);
  const result = await Promise.race([evaluation, expired]).finally(() => clearTimeout(timer));
  if (result.exceptionDetails) {
    const { exception, text } = result.exceptionDetails;
    // The page writes its own exception's message, so it is masked like a result.
    const message = await redactEvaluation(page, cdp, exception?.description ?? text, before);
    throw new ServerBrowserOperationError("PreviewAutomationExecutionError", String(message));
  }
  const value =
    "value" in result.result ? result.result.value : (result.result.description ?? null);
  const actualBytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  if (actualBytes > MAX_EVALUATION_BYTES) {
    throw new ServerBrowserOperationError(
      "PreviewAutomationResultTooLargeError",
      `Evaluation result is ${actualBytes} bytes; the limit is ${MAX_EVALUATION_BYTES}.`,
      { maximumBytes: MAX_EVALUATION_BYTES },
    );
  }
  return redactEvaluation(page, cdp, value, before);
};

/** Native Playwright waits share one deadline; recheck the conjunction on the current document. */

export const waitFor = async (
  page: Page,
  input: PreviewAutomationWaitForInput,
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const target = targetLocator(page, input);
  // Legacy presence checks accepted multiple matches, including hidden elements.
  const locator = input.state === undefined ? target?.first() : target;
  const state = input.state ?? "attached";
  const loadState =
    input.loadState === "domContentLoaded"
      ? "domcontentloaded"
      : input.loadState === "networkIdle"
        ? "networkidle"
        : input.loadState;
  const documentCondition = `(() => (
    ${input.text === undefined ? "true" : `(document.body?.innerText ?? "").includes(${JSON.stringify(input.text)})`}
    && ${input.urlIncludes === undefined ? "true" : `location.href.includes(${JSON.stringify(input.urlIncludes)})`}
  ))()`;
  const conditions = [
    ...(locator ? [`locator:${state}`] : []),
    ...(input.text === undefined ? [] : ["text"]),
    ...(input.urlIncludes === undefined ? [] : ["url"]),
    ...(input.loadState === undefined ? [] : [`load:${input.loadState}`]),
  ];
  const timeout = () =>
    new ServerBrowserOperationError(
      "PreviewAutomationTimeoutError",
      `Waited ${timeoutMs}ms without all conditions holding: ${conditions.join(", ")}.`,
    );
  let stopped = false;
  const remaining = () => {
    signal?.throwIfAborted();
    if (stopped || Date.now() >= deadline) throw timeout();
    return Math.max(1, deadline - Date.now());
  };
  let documentVersion = 0;
  const navigated = (frame: import("playwright-core").Frame) => {
    if (frame === page.mainFrame()) documentVersion++;
  };
  page.on("framenavigated", navigated);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeout()), timeoutMs);
    abort = () => reject(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
  });
  const wait = async () => {
    for (;;) {
      remaining();
      await Promise.all([
        locator?.waitFor({ state, timeout: remaining() }),
        ...(input.text === undefined && input.urlIncludes === undefined
          ? []
          : [
              page
                .waitForFunction(documentCondition, undefined, { timeout: remaining() })
                .then((handle) => handle.dispose()),
            ]),
      ]);
      remaining();
      const version = documentVersion;
      // Wait after URL/text resolve so an old document's completed load cannot satisfy a new one.
      if (loadState !== undefined) await page.waitForLoadState(loadState, { timeout: remaining() });
      remaining();
      const [locatorMatches, documentMatches] = await Promise.all([
        locator === null || locator === undefined
          ? true
          : state === "visible"
            ? locator.isVisible()
            : state === "hidden"
              ? locator.isHidden()
              : locator.count().then((count) => (state === "detached" ? count === 0 : count > 0)),
        input.text === undefined && input.urlIncludes === undefined
          ? true
          : page.evaluate(documentCondition).catch((cause: unknown) => {
              // Navigation can destroy the old execution context. Retry only that transition.
              if (
                cause instanceof Error &&
                /execution context was destroyed|cannot find context/i.test(cause.message)
              )
                return false;
              throw cause;
            }),
      ]);
      remaining();
      // Revalidate snapshot refs after a navigation even if the native locator happened to settle.
      if (target) targetLocator(page, input);
      if (version === documentVersion && locatorMatches && documentMatches === true) return;
    }
  };
  try {
    await Promise.race([wait(), interrupted]);
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof Error && cause.name === "TimeoutError") throw timeout();
    throw cause;
  } finally {
    // Playwright's read-only wait has no AbortSignal API. It may settle until its deadline,
    // but cannot start another check or hold the control queue after takeover/timeout.
    stopped = true;
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    page.off("framenavigated", navigated);
  }
};

const NET_ERROR_CODES: Readonly<Record<string, number>> = {
  ERR_FAILED: -2,
  ERR_TIMED_OUT: -7,
  ERR_CONNECTION_CLOSED: -100,
  ERR_CONNECTION_RESET: -101,
  ERR_CONNECTION_REFUSED: -102,
  ERR_NAME_NOT_RESOLVED: -105,
  ERR_INTERNET_DISCONNECTED: -106,
  ERR_ADDRESS_UNREACHABLE: -109,
  ERR_CERT_AUTHORITY_INVALID: -202,
  ERR_EMPTY_RESPONSE: -324,
};

export const parseNetError = (errorText: string) => {
  const description = /ERR_[A-Z_]+/.exec(errorText)?.[0] ?? errorText;
  return { description, code: NET_ERROR_CODES[description] ?? -2 };
};
