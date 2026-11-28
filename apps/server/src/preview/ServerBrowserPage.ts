import { SnapshotTiming } from "./snapshotTiming.ts";
import { actionabilityReason } from "./actionability.ts";
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.

import {
  type PreviewAutomationClickInput,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationDragInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationHoverInput,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationPressInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSnapshot,
  type PreviewAutomationSnapshotInput,
  type PreviewAutomationTypeInput,
  type PreviewAutomationWaitForInput,
} from "@goat/contracts";
import { constVoid } from "effect/Function";
import * as NodeCrypto from "node:crypto";
import type { CDPSession, ConsoleMessage, Frame, Locator, Page } from "playwright-core";
import { shrinkPng, shrinkJpegWithin, cappedJpegSize } from "./ServerBrowserImage.ts";
import { captureFullPage } from "./fullPageScreenshot.ts";
import { pointerInterception } from "./pointerInterception.ts";
import { subsequentClick } from "./actionClick.ts";
import { clickToState, heldKeys, type ClickReport } from "./clickState.ts";
import type { DownloadWait } from "./downloadJournal.ts";
import { waitForWithLocator } from "./actionWait.ts";
import { evaluateWithTimeout, requireEvaluationChannel } from "./actionEvaluation.ts";
import { describeReceiver } from "./pointerReceiver.ts";
import {
  abortable,
  actionCall,
  disposeAction,
  acquireTarget,
  actionDeadline,
  pinTarget,
  remaining,
  waitUntilWritable,
  type Readiness,
} from "./actionReadiness.ts";
import { withRefAnnotations } from "./annotateRefs.ts";
import { codeLocator } from "./codeLocator.ts";
import { dragBetween, wheelAt } from "./pointerInput.ts";
import { aimClick, type ClickEffect, releaseAim, watchClick } from "./clickEffect.ts";
import { aimClickPoint, assertCoordinateClickAllowed, locatePoint } from "./clickAim.ts";
import { capturePaint, occludedRefs } from "./paintOcclusion.ts";
import { resolvePageScope, scopeHidden } from "./pageScope.ts";
import { pageChanged, runSnapshot, transientCapture } from "./snapshotRetry.ts";
import {
  resetSnapshotDiff,
  snapshotOptionsResult,
  snapshotPageMetadata,
} from "./snapshotOptions.ts";
import { interactiveElementsOf, narrowTree } from "./snapshotInteractive.ts";
import { readLayersHeader } from "./blockingLayers.ts";
import {
  frameUrls,
  FRAME_ANSWER_MS,
  maskSecrets,
  maskSnapshotRecords,
  maskTree,
  protectedNumbers,
  redactValue,
  tabCookies,
  openReaders,
  dottedPattern,
} from "./pageSecrets.ts";
import { screenTree, viewportPlacement } from "./ServerBrowserScreen.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";

const MAX_EVALUATION_BYTES = 64_000;
const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_SCREENSHOT_WIDTH = 1280;
export const DIAGNOSTIC_BUFFER_LIMIT = 200;

export { ServerBrowserOperationError } from "./browserOperationError.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import {
  focusedFieldState,
  pinFocusedTarget,
  waitUntilFocusedTargetWritable,
} from "./focusedTextTarget.ts";
import { setRange } from "./rangeValue.ts";
import { scrollPositionRead, settleScroll } from "./scrollPositions.ts";
export const toOperationError = (
  cause: unknown,
  timeoutMs?: number,
): ServerBrowserOperationError => {
  if (cause instanceof BrowserControlInterrupted)
    return new ServerBrowserOperationError(
      "PreviewAutomationControlInterruptedError",
      cause.message,
      cause.reason === "blocked_url"
        ? { reason: cause.reason, beforeInput: cause.beforeInput }
        : cause.beforeInput
          ? { reason: cause.reason, beforeInput: true }
          : cause.reason,
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
  const matched = /strict mode violation:.*resolved to (\d+) elements/i.exec(message)?.[1];
  if (matched !== undefined)
    return new ServerBrowserOperationError("PreviewAutomationInvalidSelectorError", firstLine, {
      matchCount: Number(matched),
    });
  if (/while parsing selector|Unknown engine|Unexpected token/i.test(message)) {
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
  const written = codeLocator(page, selector);
  if (written !== null) return written;
  const engines = selector.replace(
    /\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    " ",
  );
  // The tree shows a ref bare, so a bare GOAT ref is one; as CSS it would match nothing.
  const bare = /^\s*(t3-[\da-f]{8}-[\da-z]+-(?:f\d+)?e\d+)\s*$/.exec(selector)?.[1]; // goat-rename: legacy
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
  (): void | Promise<void>;
  readonly linger?: (work: Promise<unknown>) => void;
  /** The gate's checks, including control changes since the action began, without dispatching. */
  readonly check?: () => void | Promise<void>;
  /** When the caller stops waiting, on the performance.now() clock; no input goes out after it. */
  readonly deadline?: number;
  readonly signal?: AbortSignal | undefined;
  readonly channel?: import("./actionChannel.ts").ActionChannel | undefined;
}
const open: DispatchGate = () => {};

/** How long an action that passed its gate may wait for Playwright's checks, within the deadline. */
const DISPATCH_TIMEOUT_MS = 1_000;

const targetChanged = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationExecutionError",
    "The target changed or was disabled before the input landed. Take a fresh snapshot and try again.",
  );

/** The target's element, after Playwright's wait for it; a detached target is a changed one. */
export const elementOf = acquireTarget;

/** A wait for the target that timed out sent nothing, so the broker can report it unsent. */
const unsentOnTimeout = (cause: unknown) =>
  cause instanceof Error && cause.name === "TimeoutError"
    ? new ServerBrowserOperationError(
        "PreviewAutomationTimeoutError",
        "The target was not found or not ready before the deadline, so no input was sent.",
        {
          beforeInput: true,
          ...(actionabilityReason(cause.message)
            ? { actionability: actionabilityReason(cause.message) }
            : {}),
        },
      )
    : cause;

/**
 * Waits for visible, enabled and stable before the gate, within the request's deadline: the
 * Playwright action after it has only a short budget, and motion can come from any script.
 */
const settled = async (
  locator: Locator,
  deadline: number,
  enabled = true,
  gate: DispatchGate = open,
) => {
  const handle = await elementOf(locator, remaining(deadline), gate.signal, gate).catch(
    (cause: unknown) => {
      throw unsentOnTimeout(cause);
    },
  );
  let waitingFor: "visible" | "enabled" | "stable" = "visible";
  try {
    await abortable(
      () =>
        actionCall(gate, () =>
          handle.waitForElementState("visible", { timeout: remaining(deadline) }),
        ),
      gate.signal,
    );
    if (enabled) {
      waitingFor = "enabled";
      await abortable(
        () =>
          actionCall(gate, () =>
            handle.waitForElementState("enabled", { timeout: remaining(deadline) }),
          ),
        gate.signal,
      );
    }
    waitingFor = "stable";
    await abortable(
      () =>
        actionCall(gate, () =>
          handle.waitForElementState("stable", { timeout: remaining(deadline) }),
        ),
      gate.signal,
    );
  } catch (cause) {
    const error = unsentOnTimeout(cause);
    if (
      error instanceof ServerBrowserOperationError &&
      error.tag === "PreviewAutomationTimeoutError"
    )
      throw new ServerBrowserOperationError(error.tag, error.message, {
        ...(typeof error.detail === "object" && error.detail !== null ? error.detail : {}),
        actionability: waitingFor,
      });
    throw error;
  } finally {
    disposeAction(gate, handle);
  }
};

const dispatched = (deadline: number) =>
  ({ timeout: Math.min(DISPATCH_TIMEOUT_MS, remaining(deadline)), noWaitAfter: true }) as const;

const targetPoint = (
  page: Page,
  locator: Locator | null,
  input: { readonly x?: number | undefined; readonly y?: number | undefined },
  deadline: number,
  gate: DispatchGate,
) =>
  locatePoint(page, locator, input, deadline, gate).catch((cause: unknown) => {
    throw unsentOnTimeout(cause);
  });

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

export const captureViewportWithin = async (
  cdp: CDPSession,
  quality: number,
  bounds: { readonly maxWidth: number; readonly maxHeight: number },
) => {
  const data = await captureViewport(cdp, { format: "jpeg", quality });
  return (await shrinkJpegWithin(cdp, data, quality, bounds)) ?? data;
};

type SnapshotInput = PreviewAutomationSnapshotInput & {
  readonly agentSessionId?: string | undefined;
  readonly actionChannel?: import("./actionChannel.ts").ActionChannel | undefined;
  readonly page: Page;
  readonly cdp: CDPSession;
  /** Headless pages render at the scale the server set; a desktop page at its display's. */
  readonly renderScale: number | "display";
  readonly fullPage?: boolean | undefined;
  /** Keep the uncapped capture beside the one the agent sees, for a saved file. */
  readonly fullScreenshot?: boolean | undefined;
  /** False skips the capture when nothing would show or save the image (L4). */
  readonly captureImage?: boolean;
  readonly measureSnapshotFrame?: true | (() => boolean) | undefined;
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

type CapturedScreenshot = {
  readonly image: NonNullable<PreviewAutomationSnapshot["screenshot"]>;
  /** The capture before `image` was capped, when a saved file asked for full resolution. */
  readonly full?: string | undefined;
};

const capture = async (
  input: SnapshotInput,
  deadline: number,
  timing: SnapshotTiming,
): Promise<PreviewAutomationSnapshot> => {
  const track = timing.track.bind(timing);
  const { renderScale, viewport } = await track("metrics", () => renderingOf(input));
  // A late metrics reply must not begin a capture after viewers have resumed.
  if (Date.now() >= deadline) throw timing.timeout(input.timeoutMs);
  const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / (viewport.width * renderScale));
  const state = refsFor(input.page);
  const scoped = input.scope ? await resolvePageScope(input.page, input.scope) : undefined;
  invalidateRefs(input.page, true);
  const generation = state.generation;
  const { readers, read } = await track("frames", () => openReaders(input.page, input.cdp));
  const before = await track("frames", () => read());
  const captureImage = (): Promise<CapturedScreenshot | undefined> =>
    input.captureImage === false
      ? Promise.resolve(undefined)
      : input.fullPage
        ? captureFullPage(input.cdp).then((image) => ({ image }))
        : captureViewport(input.cdp, { format: "png" }).then(async (png) => {
            const data = scale < 1 ? await shrinkPng(input.cdp, png, scale) : png;
            return {
              image: {
                mimeType: "image/png" as const,
                data,
                ...viewportPlacement(viewport, pngSize(data)),
              },
              ...(scale < 1 && input.fullScreenshot === true ? { full: png } : {}),
            };
          });
  const canMeasureFrame = () =>
    input.captureImage === false &&
    input.renderScale !== "display" &&
    (input.measureSnapshotFrame === true || input.measureSnapshotFrame?.() === true);
  // Taken between the reads, so a value that changes during either fails the comparison.
  // Awaited after the tree: a capture that fails has finished its tree before a retry starts.
  const pageAndScreenshot = Promise.all([
    track("page state", () => snapshotPageMetadata(input.page, scoped)),
    track("page state", () => readLayersHeader(input.page)),
    input.annotate || input.captureImage === false ? undefined : track("screenshot", captureImage),
    track("frames", () => tabCookies(input.page)),
    track("page state", () => capturePaint(input.cdp)),
    canMeasureFrame()
      ? track("screenshot", async () =>
          viewportPlacement(
            viewport,
            cappedJpegSize(
              await captureViewport(input.cdp, { format: "jpeg", quality: 10 }),
              scale,
            ),
          ),
        )
      : undefined,
  ]);
  void pageAndScreenshot.catch(constVoid);
  let tree: string;
  let capturedScreenshot: CapturedScreenshot | undefined;
  let unread: ReadonlyArray<Frame> = [];
  let dotted: ReturnType<typeof dottedPattern>;
  try {
    // Leaves time for the second read; a frame that never loads holds the tree until then.
    tree = await track("accessibility tree", () =>
      (scoped ?? input.page).ariaSnapshot({
        mode: "ai",
        boxes: true,
        timeout: Math.max(1, deadline - Date.now() - 2_000),
      }),
    );
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
            () => track("screenshot", captureImage),
            input.actionChannel,
          )
        : Promise.resolve(undefined);
    capturedScreenshot = await image;
    const after = await track("frames", () => read(before));
    // A value that changed meanwhile may be in the tree under neither reading.
    if (after.some((values, i) => values && JSON.stringify(values) !== JSON.stringify(before[i])))
      throw pageChanged();
    dotted = dottedPattern(after.flatMap((values) => values ?? []));
    // A frame that didn't answer both times, such as one that crashed, can only hold values the
    // tree shows if the tree shows its content.
    unread = readers.flatMap((reader, i) => (after[i] ? [] : reader.frames));
    const filled = /^\s*- iframe (?:\[active\] )?\[ref=(\S+?)\].*:$/gm;
    for (const [, ref] of unread.length ? tree.matchAll(filled) : []) {
      const iframe = await track("frames", () =>
        input.page.locator(`aria-ref=${ref}`).elementHandle({ timeout: 2_000 }),
      );
      if (!iframe) throw pageChanged();
      const frame = await track("frames", () => iframe.contentFrame());
      void iframe.dispose().catch(constVoid);
      if (frame && unread.includes(frame)) throw timing.unreadFrame(FRAME_ANSWER_MS);
    }
  } catch (cause) {
    await pageAndScreenshot.catch(constVoid);
    throw cause;
  }
  const [captured, layersLine, capturedImage, cookies, paint, screenshotSize] =
    await pageAndScreenshot;
  // Checked after the reads: an embedding frame element can be hidden while they run.
  const hidden = scoped ? await scopeHidden(scoped) : false;
  const page = hidden ? { ...captured, visibleText: "" } : captured;
  if (hidden) tree = "";
  capturedScreenshot ??= capturedImage;
  const screenshot = capturedScreenshot?.image;
  const full = capturedScreenshot?.full;
  if (state.generation !== generation) throw pageChanged();
  const filled = input.diagnostics?.mask ?? ((text: string) => text);
  const secrets = maskSecrets(dotted, cookies);
  const mask = (text: string, limit?: number) => filled(secrets(text), limit).slice(0, limit);
  // Redacted before the cut, so a payload crossing it can't leave its start showing, and before
  // masking, which could hide the `data:` scheme behind a password value's dots.
  const redacted = withoutTreeDataPayloads(tree);
  const masked = maskTree(redacted, dotted, cookies);
  // An interactive-only tree keeps lines from past the cut, so it is masked in full.
  const visible = filled(masked, input.interactiveOnly ? undefined : MAX_VISIBLE_TEXT_LENGTH);
  // The tab's mask cuts a long tree a little past the limit, maybe inside a line, and masking can
  // leave it shorter than screenTree's cut, so its last line is dropped here.
  const cut = !input.interactiveOnly && masked.length > MAX_VISIBLE_TEXT_LENGTH;
  const narrowed = narrowTree(
    cut ? visible.slice(0, Math.max(0, visible.lastIndexOf("\n"))) : visible,
    input.interactiveOnly,
  );
  const { accessibilityTree, ...treeFields } = screenTree(`${mask(layersLine)}\n${narrowed}`, {
    limit: MAX_VISIBLE_TEXT_LENGTH,
    unread,
    generation,
    refs: state.refs,
    occluded: occludedRefs(paint, tree),
  });
  const treeComplete = treeFields.treeComplete && !cut;
  return snapshotOptionsResult(
    input.page,
    {
      ...page,
      url: mask(withoutDataPayload(page.url)),
      title: mask(page.title),
      // Mask text before truncating so a value crossing the cut cannot leak its prefix.
      visibleText: mask(page.visibleText, MAX_VISIBLE_TEXT_LENGTH),
      accessibilityTree,
      interactiveElements: interactiveElementsOf(accessibilityTree, !treeComplete),
      ...treeFields,
      treeComplete,
      ...maskSnapshotRecords(mask, input),
      ...(screenshot === undefined ? {} : { screenshot }),
      ...(screenshotSize === undefined || !canMeasureFrame() ? {} : { screenshotSize }),
      ...(full === undefined ? {} : { fullScreenshot: { data: full, ...pngSize(full) } }),
    },
    input,
    page.visibleText.length,
    unread.length,
    narrowed.length + layersLine.length + 1,
  );
};

export const snapshot = (
  input: SnapshotInput,
  timing = new SnapshotTiming(),
): Promise<PreviewAutomationSnapshot> =>
  runSnapshot({
    page: input.page,
    timeoutMs: input.timeoutMs,
    capture: (deadline) => capture(input, deadline, timing),
    retryable: transientCapture,
    tooBusy: () => timing.timeout(input.timeoutMs),
  });

const clickTarget = async (
  page: Page,
  input: PreviewAutomationClickInput,
  pointer: PointerReporter = noPointer,
  gate: DispatchGate = open,
): Promise<
  { readonly x: number; readonly y: number; readonly pressesCompleted?: number } & ClickEffect
> => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = actionDeadline(timeout, gate.deadline);
  const locator = targetLocator(page, input);
  const rough = await targetPoint(page, locator, input, deadline, gate);
  if (locator !== null) await settled(locator, deadline, true, gate);
  const aimed =
    locator === null
      ? { point: rough }
      : await aimClickPoint(page, locator, deadline, gate).catch((cause: unknown) => {
          throw unsentOnTimeout(cause);
        });
  const { point } = aimed;
  const button = input.button ?? "left";
  const keys = heldKeys(page, gate, input.modifiers);
  let sent = false;
  let dialog = false;
  let onDialog = constVoid;
  let dialogBeforePress = false;
  let dialogShown = false;
  let clicked = false;
  const dialogOpened = new Promise<"dialog">((resolve) => {
    onDialog = () => {
      dialogBeforePress = !sent;
      dialogShown = true;
      resolve("dialog");
    };
    page.once("dialog", onDialog);
  });
  const aim = await aimClick(
    page,
    locator,
    point,
    gate,
    locator === null ? Math.min(2_000, remaining(deadline)) : undefined,
  );
  const watch = await (
    locator === null && !dialogBeforePress
      ? assertCoordinateClickAllowed(aim.frame, "point" in aim ? aim.point : point, gate)
      : Promise.resolve()
  )
    .then(() => pointer(point, "click"))
    .then(() => watchClick(page, aim.frame, gate))
    .catch((cause: unknown) => {
      page.off("dialog", onDialog);
      releaseAim(aim, gate);
      throw cause;
    });
  // Each press goes out on its own after the gate: Playwright sends a double click's presses
  // together, and the browser still delivers the rest after the first opens a dialog.
  const press = async (count: number) => {
    // A dialog the page opened before the press is not the click's, and holds the page: send nothing.
    if (dialogBeforePress)
      throw new BrowserControlInterrupted(
        'A browser dialog opened before the click, so nothing was sent. Read goat_call {path:"preview.status"} and answer it with goat_call {path:"preview.dialog"} first.',
        "dialogPending",
        true,
      );
    // A later press after the deadline is refused too, but the first one may already have landed.
    if (count === 1) remaining(deadline);
    else if (performance.now() >= deadline)
      throw new ServerBrowserOperationError(
        "PreviewAutomationTimeoutError",
        "The click's deadline passed after its first press; the later presses were not sent.",
      );
    await gate();
    gate.signal?.throwIfAborted();
    sent = true;
    if (count === 1) await keys.press();
    // A dialog a key-down opened holds the page; once it is answered, the click stays unsent.
    if (dialogShown) return undefined;
    clicked = true;
    if (count === 1)
      return locator === null || ("associatedLabel" in aimed && aimed.associatedLabel === true)
        ? requireEvaluationChannel(gate).call(() => page.mouse.click(point.x, point.y, { button }))
        : requireEvaluationChannel(gate).call(() =>
            locator.click({
              button,
              ...("position" in aimed ? { position: aimed.position } : {}),
              ...dispatched(deadline),
            }),
          );
    return subsequentClick(gate, point, button, count);
  };
  let presses = 0;
  try {
    await watch.arm(aim);
    for (let count = 1; count <= (input.clickCount ?? 1); count++) {
      const pressed = press(count);
      if ((await Promise.race([pressed, dialogOpened])) === "dialog") {
        // That press waits on the dialog, past this action; later presses are never sent.
        dialog = true;
        gate.linger?.(pressed);
        void pressed.catch(constVoid);
        break;
      }
      presses = count;
    }
  } catch (cause) {
    watch.cancel();
    releaseAim(aim, gate);
    throw await withReceiver(page, locator, cause, deadline);
  } finally {
    page.off("dialog", onDialog);
    await keys.release(dialog, gate.linger);
  }
  if (!sent) watch.cancel();
  const outcome = await watch.settle(dialog).finally(() => releaseAim(aim, gate));
  // A dialog that stopped a multi-press click, or a held key's dialog before any press, leaves it short.
  const short = (input.clickCount ?? 1) > presses && ((input.clickCount ?? 1) > 1 || !clicked);
  return { ...point, ...outcome, ...(short ? { pressesCompleted: presses } : {}) };
};
export const click = async (
  page: Page,
  input: PreviewAutomationClickInput,
  pointer: PointerReporter = noPointer,
  gate: DispatchGate = open,
): Promise<ClickReport> => {
  try {
    if (input.checked === undefined) return await clickTarget(page, input, pointer, gate);
    const timeout = remaining(actionDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, gate.deadline));
    return await clickToState(targetLocator(page, input), input.checked, gate, timeout, () =>
      clickTarget(page, input, pointer, gate),
    );
  } catch (cause) {
    const timedOut =
      (cause instanceof ServerBrowserOperationError &&
        cause.tag === "PreviewAutomationTimeoutError") ||
      (cause instanceof Error && cause.name === "TimeoutError");
    const target = input.locator ?? input.selector;
    if (!timedOut || target === undefined) throw cause;
    const detail =
      cause instanceof ServerBrowserOperationError &&
      typeof cause.detail === "object" &&
      cause.detail !== null
        ? cause.detail
        : {};
    const beforeInput = "beforeInput" in detail && detail.beforeInput === true;
    const label = JSON.stringify(target.length > 200 ? `${target.slice(0, 200)}...` : target);
    const baseReason = beforeInput
      ? `No input was sent. The click target ${label} was not ready before the deadline.`
      : `The click may have been sent; check the page before retrying. The target was ${label}.`;
    const actionability = "actionability" in detail ? detail.actionability : undefined;
    const reason =
      actionability === "visible" || actionability === "enabled" || actionability === "stable"
        ? `${baseReason} Playwright last saw: element is not ${actionability}.`
        : baseReason;
    throw new ServerBrowserOperationError("PreviewAutomationTimeoutError", reason, {
      ...detail,
      reason,
    });
  }
};
export const type = async (
  page: Page,
  input: PreviewAutomationTypeInput,
  gate: DispatchGate = open,
  readiness: Readiness = {},
) => {
  const deadline = actionDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, gate.deadline);
  const channel = gate.channel;
  if (!channel) throw new Error("An action channel is required for typing.");
  const locator = targetLocator(page, input);
  const handle = locator
    ? await pinTarget(locator, deadline, gate.signal, gate)
    : await pinFocusedTarget(page, deadline, gate);
  try {
    if (handle) {
      if (locator) await waitUntilWritable(handle, deadline, readiness, gate);
      else await waitUntilFocusedTargetWritable(page, handle, deadline, readiness, gate);
      await gate();
    }
    gate.signal?.throwIfAborted();
    const phase = input.clear === true ? "clear" : "focus";
    const focused = handle && (await channel.call(() => handle.evaluate(focusedFieldState, phase)));
    const notEditable = () =>
      new ServerBrowserOperationError(
        "PreviewAutomationTargetNotEditableError",
        "The target is not an enabled text field, so no text was typed.",
      );
    const checkDispatch = async (phase: "range" | "dispatch") => {
      remaining(deadline);
      await gate();
      gate.signal?.throwIfAborted();
      if (
        !locator &&
        handle &&
        !(await channel.call(() => handle.evaluate(focusedFieldState, phase)))
      )
        throw notEditable();
      remaining(deadline);
    };
    if (focused === "range" && handle) {
      await checkDispatch("range");
      return await channel.call(() => setRange(handle, input.text));
    }
    if (focused !== "text" && focused !== "editable") throw notEditable();
    if (input.clear && handle) {
      await gate();
      gate.signal?.throwIfAborted();
      await channel.call(() =>
        handle.evaluate((element, textControl) => {
          if (textControl) (element as unknown as { select(): void }).select();
          else
            (
              globalThis as unknown as {
                getSelection(): { selectAllChildren(node: unknown): void } | null;
              }
            )
              .getSelection()
              ?.selectAllChildren(element);
        }, focused === "text"),
      );
    }
    await readiness.onHistoryFocus?.();
    await checkDispatch("dispatch");
    // One input after the gate: a key press is held off by the input fence; inserted text is a
    // single call with nothing to wait for.
    if (input.text === "") {
      if (input.clear) await channel.keyboard.press("Delete");
      return;
    }
    await channel.keyboard.insertText(input.text);
  } finally {
    if (handle && !gate.signal?.aborted) void channel.dispose(handle).catch(constVoid);
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
  const channel = gate.channel;
  if (!channel) throw new Error("An action channel is required for hover.");
  // Hovering only shows things, so a selector naming several rows hovers the first of them.
  const locator = targetLocator(page, input)?.first() ?? null;
  await pointer(await targetPoint(page, locator, input, deadline, gate), "move");
  if (locator === null) {
    remaining(deadline);
    await gate();
    gate.signal?.throwIfAborted();
    await channel.mouse.move(input.x ?? 0, input.y ?? 0);
    return;
  }
  await settled(locator, deadline, false, gate);
  remaining(deadline);
  await gate();
  gate.signal?.throwIfAborted();
  await channel.call(() => locator.hover(dispatched(deadline)));
};

export { select } from "./actionSelect.ts";

export const drag = async (
  page: Page,
  input: PreviewAutomationDragInput,
  pointer: PointerReporter = noPointer,
  gate: DispatchGate = open,
) => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = actionDeadline(timeout, gate.deadline);
  if (input.from && input.to) {
    await pointer(input.from, "move");
    await dragBetween(page, { ...input, from: input.from, to: input.to }, gate, deadline);
    return pointer(input.to, "move");
  }
  const source = targetLocator(page, { locator: input.source })!;
  const target = targetLocator(page, { locator: input.target })!;
  const start = await targetPoint(page, source, {}, deadline, gate);
  await pointer(start, "move");
  await settled(source, deadline, false, gate);
  await settled(target, deadline, false, gate);
  const end = await actionCall(gate, () =>
    target.boundingBox({ timeout: remaining(deadline) }),
  ).catch(() => null);
  if (!end) throw targetChanged();
  const finish = { x: end.x + end.width / 2, y: end.y + end.height / 2 };
  await pointer(finish, "move");
  await dragBetween(page, { from: start, to: finish }, gate, deadline);
};
export const press = async (
  _page: Page,
  input: PreviewAutomationPressInput,
  gate: DispatchGate = open,
) => {
  const channel = gate.channel;
  if (!channel) throw new Error("An action channel is required for keyboard input.");
  await gate();
  gate.signal?.throwIfAborted();
  await channel.keyboard.press([...(input.modifiers ?? []), input.key].join("+"));
};

export const scroll = async (
  page: Page,
  input: PreviewAutomationScrollInput,
  gate: DispatchGate = open,
): Promise<{ readonly settled: boolean }> => {
  const delta = [input.deltaX ?? 0, input.deltaY ?? 0] as const;
  const channel = requireEvaluationChannel(gate);
  if (input.x !== undefined && input.y !== undefined) {
    await wheelAt(page, { x: input.x, y: input.y }, delta, gate, gate.deadline ?? Infinity);
    return {
      settled: await settleScroll(
        channel,
        scrollPositionRead(page, { point: { x: input.x, y: input.y } }),
        gate.deadline,
      ),
    };
  }
  const locator = targetLocator(page, input);
  if (locator === null) {
    await gate();
    gate.signal?.throwIfAborted();
    // Page-side code is passed as source: the server compiles without DOM types.
    await actionCall(gate, () => page.evaluate(`scrollBy(${delta[0]}, ${delta[1]})`));
    return {
      settled: await settleScroll(channel, scrollPositionRead(page, undefined), gate.deadline),
    };
  }
  const handle = await elementOf(locator, DEFAULT_TIMEOUT_MS, gate.signal, gate);
  try {
    await gate();
    gate.signal?.throwIfAborted();
    await actionCall(gate, () =>
      input.deltaX === undefined && input.deltaY === undefined
        ? handle.scrollIntoViewIfNeeded({ timeout: DISPATCH_TIMEOUT_MS })
        : handle.evaluate((element, [x, y]) => element.scrollBy(x, y), delta),
    );
    return {
      settled: await settleScroll(
        channel,
        scrollPositionRead(page, { element: handle }),
        gate.deadline,
      ),
    };
  } finally {
    disposeAction(gate, handle);
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
  return redactValue(value, maskSecrets(dottedPattern(values), cookies), protectedNumbers(values));
};

/** Terminate expired page scripts so a hung expression cannot block the tab's control queue. */
export const evaluate = async (
  { page, cdp }: { readonly page: Page; readonly cdp: CDPSession },
  input: PreviewAutomationEvaluateInput,
  timeoutMs: number,
  gate?: DispatchGate,
) => {
  const before = frameUrls(page);
  await gate?.();
  const channel = requireEvaluationChannel(gate);
  const result = await evaluateWithTimeout(channel, input, timeoutMs);
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

export const waitFor = (
  page: Page,
  input: PreviewAutomationWaitForInput,
  signal?: AbortSignal,
  downloads?: DownloadWait,
) => waitForWithLocator(targetLocator, DEFAULT_TIMEOUT_MS, page, input, signal, downloads);

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
  // Names can hold digits, as in ERR_HTTP2_PROTOCOL_ERROR.
  const description = /ERR_[A-Z\d_]+/.exec(errorText)?.[0] ?? errorText;
  return { description, code: NET_ERROR_CODES[description] ?? -2 };
};
