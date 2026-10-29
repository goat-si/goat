// @effect-diagnostics preferSchemaOverJson:off - Timing is attached only when the serialized reply still fits its byte budget.
/**
 * A desktop read with its host time: observe, a page of a cut read, and screenshot, timed by step
 * ({ ms, phases: { driverMs, parseMs, renderMs, bridgeMs } }), with the tree post-processing small
 * windows need and the screenshot path that keeps a tree's refs skipping the tree altogether.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type {
  ComputerUsePrimitiveReply,
  ScreenHostCall,
  ScreenImageMetadata,
  ScreenObservation,
  ScreenReadPhases,
  ScreenRunError,
} from "@goat/contracts";
import { COMPUTER_USE_PRIMITIVE_RESULT_TOO_LARGE } from "@goat/contracts";
import { driverValue, fail } from "./DesktopDriverReplies.ts";
import { settleCaptureIfNeeded } from "./DesktopEvidence.ts";
import { boundsOf, elementFrames, sameRect } from "./DesktopFrames.ts";
import { inspectTreeElements } from "./DesktopInputGuards.ts";
import {
  boundedReadDetail,
  buildObservedDraft,
  desktopQuery,
  desktopRows,
  driverQuery,
  matchesQuery,
  observeScope,
  queryOmission,
  READ_BOUNDS,
  renderFailure,
  renderPageObservation,
  shownTree,
  treeOf,
  type DesktopQuery,
} from "./DesktopObserveRead.ts";
import { buildScreenshotCapture, treeWindowBasis } from "./DesktopTargetPoints.ts";
import { cleanActionText, isInteractive, keepTreeLines } from "./DesktopTreeText.ts";
import { checkWindowReplyState, sheetParentId } from "./DesktopWindows.ts";
import {
  observationReplyBudget,
  type ScreenHostContext,
  type ScreenHostDispatchResult,
} from "./ScreenHostBridge.ts";
import type { ScreenObservations } from "./ScreenObservations.ts";
import type { BoundWindow } from "./DesktopTargetHost.ts";

export interface ObserveTiming {
  readonly ms: number;
  readonly phases: ScreenReadPhases;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const array = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const natural = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const elapsed = (from: number, to: number) => Math.max(0, to - from);

/** ms is the host's elapsed time; bridgeMs is what the host spent outside the timed steps. */
export const buildObserveTiming = (input: {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly driverMs: number;
  readonly parseMs: number;
  readonly renderMs: number;
}): ObserveTiming => {
  const ms = elapsed(input.startedAt, input.endedAt);
  const driverMs = Math.max(0, input.driverMs);
  const parseMs = Math.max(0, input.parseMs);
  const renderMs = Math.max(0, input.renderMs);
  return {
    ms,
    phases: {
      driverMs,
      parseMs,
      renderMs,
      bridgeMs: Math.max(0, ms - driverMs - parseMs - renderMs),
    },
  };
};

/** The observation with its timing when that still fits the tree budget; otherwise unchanged. */
export const withObserveTiming = (
  observation: ScreenObservation,
  timing: ObserveTiming,
  rawBudget: number,
): ScreenObservation => {
  const timed = { ...observation, ms: timing.ms, phases: timing.phases };
  return Buffer.byteLength(JSON.stringify(timed)) <= Math.min(rawBudget, 128 * 1024)
    ? timed
    : observation;
};

/** A screenshot's reply value with its timing when that still fits returnBytes. */
const withScreenshotTiming = (
  metadata: ScreenImageMetadata,
  timing: ObserveTiming,
  returnBytes: number,
): ScreenImageMetadata | (ScreenImageMetadata & ObserveTiming) => {
  const timed = { ...metadata, ms: timing.ms, phases: timing.phases };
  return Buffer.byteLength(JSON.stringify(timed)) <= returnBytes ? timed : metadata;
};

const buildDesktopReadArgs = (input: {
  readonly pid: number;
  readonly windowId: number;
  readonly capture: boolean;
  readonly limit: number;
  readonly filter?: string | undefined;
}): Record<string, unknown> => ({
  pid: input.pid,
  window_id: input.windowId,
  include_accessibility_tree: !input.capture,
  include_screenshot: input.capture,
  max_elements: input.limit,
  ...(input.capture ? {} : { tree_format: "both" }),
  ...(input.filter === undefined ? {} : { query: input.filter }),
});

/**
 * The tree's observation a screenshot keeps: one that kept the tree's driver snapshot keeps its
 * tokens, so the tree's refs stay and the screenshot only adds its region.
 */
const keptScreenshotObservationId = (
  capture: boolean,
  bound: Pick<BoundWindow, "snapshotId" | "observationId">,
  state: Record<string, unknown>,
): string | undefined =>
  capture &&
  bound.snapshotId !== undefined &&
  string(state.snapshot_id) === bound.snapshotId &&
  !array(state.invalidated_snapshot_ids).includes(bound.snapshotId)
    ? bound.observationId
    : undefined;

const NAMED_BY_TEXT_ROLES = ["AXRow", "AXCell", "AXOutlineRow"];
/**
 * Whether the tree text can name an element: desktopRows names only a listed element without a
 * label, from text under a row or cell line. Otherwise the text adds nothing to the rows.
 */
export const canLiftNamesFromTree = (
  elements: ReadonlyArray<Record<string, unknown>>,
  markdown: string,
) =>
  NAMED_BY_TEXT_ROLES.some((role) => markdown.includes(role)) &&
  elements.some(
    (entry) =>
      string(entry.element_token) !== undefined &&
      natural(entry.element_index) !== undefined &&
      string(entry.label) === undefined,
  );

const NUMBERED = /^- \[(\d+)\] /;
const UNNUMBERED_TEXT = /^\s*- AXStaticText/m;
/**
 * shownTree in one pass for the common case: no text line to pair, and every numbered line shows
 * its listed element as the driver writes it. Anything else goes through shownTree.
 */
export const fastShownTree = (
  markdown: string,
  elements: ReadonlyArray<Record<string, unknown>> | undefined,
  filtered: boolean,
): string => {
  const slow = () => shownTree(markdown, filtered ? undefined : elements);
  if (UNNUMBERED_TEXT.test(markdown)) return slow();
  if (!filtered && elements !== undefined) {
    // Each listed element's line head, normalized as listedOf and verifiedIndexes read them.
    const heads = new Map<number, string>();
    for (const entry of elements) {
      const index = natural(entry.element_index);
      if (index === undefined) continue;
      const label = typeof entry.label === "string" ? entry.label : undefined;
      const value = typeof entry.value === "string" ? entry.value : undefined;
      if (heads.has(index) || /[\r\n]/.test((label ?? "") + (value ?? ""))) return slow();
      const role = string(entry.role) ?? "";
      heads.set(
        index,
        "- [" + index + "] " + role + (label === undefined ? "" : ' "' + label + '"'),
      );
    }
    const seen = new Set<number>();
    for (const raw of markdown.split("\n")) {
      const line = raw.trimStart();
      const number = NUMBERED.exec(line)?.[1];
      if (number === undefined) continue;
      const index = Number(number);
      const head = heads.get(index);
      if (head === undefined || seen.has(index) || !line.startsWith(head)) return slow();
      const next = line.charAt(head.length);
      if (next !== "" && next !== " ") return slow();
      seen.add(index);
    }
  }
  return markdown.includes("name:") ? cleanActionText(markdown) : markdown;
};

/** A read's rows, the ones shown and their text, from the driver's state. */
const parseDesktopTreeState = (input: {
  readonly state: Record<string, unknown>;
  readonly filtered: boolean;
  readonly query: DesktopQuery | undefined;
  readonly interactive: boolean;
}) => {
  const elements = array(input.state.elements)
    .map(object)
    .filter((entry) => entry !== undefined);
  const markdown = treeOf(input.state, elements, input.filtered);
  const rows = desktopRows(elements, canLiftNamesFromTree(elements, markdown) ? markdown : "");
  const query = input.query;
  const shown = query
    ? rows.filter((row) => matchesQuery(row, query))
    : input.interactive
      ? rows.filter(isInteractive)
      : rows;
  const treeText = fastShownTree(markdown, input.filtered ? undefined : elements, input.filtered);
  const shownText =
    query || input.interactive
      ? keepTreeLines(
          treeText,
          new Set(shown.flatMap((row) => (row.index === undefined ? [] : [row.index]))),
        )
      : treeText;
  return { elements, rows, shown, shownText };
};

export interface DesktopObserveDeps {
  readonly observations: ScreenObservations;
  readonly targets: Map<string, BoundWindow>;
  readonly boundRequest: (
    bound: BoundWindow,
    needs: "nothing",
    tool: string,
    args: Record<string, unknown>,
    call: ScreenHostCall,
    context: ScreenHostContext,
  ) => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;
  /** The host's latest target generation, and its update when a sheet's parent takes over. */
  readonly epoch: () => number;
  readonly setEpoch: (epoch: number) => void;
}

/** The next part of a read its budget cut, from the elements it already holds: no driver call. */
const observePage = Effect.fn("DesktopObserveLatency.page")(function* (
  deps: DesktopObserveDeps,
  bound: BoundWindow,
  call: ScreenHostCall,
  context: ScreenHostContext,
  args: Record<string, unknown>,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const rawBudget = observationReplyBudget(call, context.limits);
  const res = renderPageObservation(
    deps.observations,
    bound.pages,
    bound.observationId,
    bound.ref,
    bound.epoch,
    bound.windowBounds,
    args,
    rawBudget,
  );
  if (res.error || !res.observation)
    return yield* Effect.fail(res.error ?? fail("downstream_failure"));
  const endedAt = yield* Clock.currentTimeMillis;
  const timing = buildObserveTiming({
    startedAt,
    endedAt,
    driverMs: 0,
    parseMs: 0,
    renderMs: elapsed(startedAt, endedAt),
  });
  return {
    value: withObserveTiming(res.observation, timing, rawBudget),
    category: "unverifiable" as const,
  };
});

export const runDesktopObserve = Effect.fn("DesktopObserveLatency.observe")(function* (
  deps: DesktopObserveDeps,
  bound: BoundWindow,
  call: ScreenHostCall,
  context: ScreenHostContext,
  args: Record<string, unknown>,
): Effect.fn.Return<ScreenHostDispatchResult, ScreenRunError> {
  const { observations } = deps;
  const capture = call.method === "screenshot";
  if (!capture && args.after !== undefined)
    return yield* observePage(deps, bound, call, context, args);
  const startedAt = yield* Clock.currentTimeMillis;
  let driverMs = 0;
  let parseMs = 0;
  let renderMs = 0;
  const query = !capture && args.mode === "query" ? desktopQuery(args.query) : undefined;
  if (!capture && args.mode === "query" && !query)
    return yield* Effect.fail(
      fail("invalid_argument", "Query by {role, name, text, id}: name at least one."),
    );
  const search = query && driverQuery(query);
  // A driver diff (`since`) keeps only changed rows and retires the others' tokens, and
  // goat.7 fails its own count check on it, so every desktop read is full: all refs stay usable.
  const read = Effect.fn("DesktopObserveLatency.read")(function* (
    limit: number,
    filter?: string,
    windowId = bound.windowId,
  ) {
    const sentAt = yield* Clock.currentTimeMillis;
    const reply = yield* deps.boundRequest(
      bound,
      "nothing",
      "get_window_state",
      buildDesktopReadArgs({ pid: bound.pid, windowId, capture, limit, filter }),
      call,
      context,
    );
    driverMs += elapsed(sentAt, yield* Clock.currentTimeMillis);
    return reply;
  });
  // A read that ran retired the driver's earlier tokens, so their refs go even when its
  // answer is unusable; only a driver naming another window makes the binding stale.
  const retire = () => {
    observations.evictTarget(bound.ref.id);
    delete bound.observationId;
    delete bound.snapshotId;
    delete bound.pages;
    delete bound.elementsByToken;
    delete bound.rows;
  };
  let limit: number = READ_BOUNDS[0];
  yield* settleCaptureIfNeeded(capture, bound, call.deadlineMillis);
  let reply = yield* read(limit);
  const oversized = () =>
    object(driverValue(reply))?.code === COMPUTER_USE_PRIMITIVE_RESULT_TOO_LARGE;
  // Retire before any retry, which may fail after this read already retired the old tokens.
  if (oversized()) retire();
  // A query reads the bounded window whole, where names from nearby text are known, and asks
  // the driver to filter only when that is too large.
  const filtered = query !== undefined && search !== undefined && oversized();
  if (filtered) reply = yield* read(limit, search);
  // A whole tree too large to carry walks fewer elements, within the call's deadline; a
  // query walks at least the driver's own floor, so a smaller bound would not shrink it.
  for (const smaller of capture || query ? [] : READ_BOUNDS.slice(1)) {
    if (!oversized() || (yield* Clock.currentTimeMillis) >= call.deadlineMillis) break;
    limit = smaller;
    reply = yield* read(limit);
  }
  const verifyReply = (raw: Record<string, unknown> | undefined, expectedWid: number) => {
    const checked = checkWindowReplyState(
      raw,
      bound.pid,
      expectedWid,
      capture,
      query !== undefined,
    );
    if (checked.ok) return Effect.succeed(checked.state);
    retire();
    if (checked.evictTarget) deps.targets.delete(bound.ref.id);
    return Effect.fail(checked.error);
  };
  let state = yield* verifyReply(object(driverValue(reply)), bound.windowId);
  const fromSheetId = bound.windowId;
  const parentId = !capture ? sheetParentId(state) : undefined;
  const followedSheet =
    parentId !== undefined &&
    parentId !== fromSheetId &&
    (yield* Clock.currentTimeMillis) < call.deadlineMillis;
  if (followedSheet && parentId !== undefined) {
    retire();
    reply = yield* read(limit, filtered ? search : undefined, parentId);
    state = yield* verifyReply(object(driverValue(reply)), parentId);
  }
  const expectedWindowId = followedSheet && parentId !== undefined ? parentId : bound.windowId;
  const interactive = !capture && args.interactiveOnly === true;
  const nextBounds = followedSheet
    ? (boundsOf(state.window_bounds) ??
      bound.boundWindows?.find((w) => w.window_id === expectedWindowId)?.bounds)
    : bound.windowBounds;
  const rawBudget = observationReplyBudget(call, context.limits);
  // A screenshot-only read that kept the tree's driver snapshot keeps its tokens, so the tree's
  // observation, rows and frames stay and the reply's tree is not read at all. Any other read
  // has retired them in the driver, so the old refs go now, before a render that may fail.
  const kept = keptScreenshotObservationId(capture, bound, state);
  let observationId = kept;
  if (kept === undefined) {
    const parseAt = yield* Clock.currentTimeMillis;
    const tree = parseDesktopTreeState({ state, filtered, query, interactive });
    const omitted = query
      ? queryOmission(state, tree.shown.length, filtered)
      : limit < READ_BOUNDS[0]
        ? [{ kind: "budget" as const, detail: boundedReadDetail(limit) }]
        : [];
    observations.evictTarget(bound.ref.id);
    delete bound.observationId;
    delete bound.snapshotId;
    bound.rows = tree.shown;
    bound.frames = elementFrames(tree.elements);
    bound.elementsByToken = inspectTreeElements(tree.elements, tree.rows);
    const basis = treeWindowBasis(bound.frames, nextBounds);
    if (basis === undefined) delete bound.framesBasis;
    else bound.framesBasis = basis;
    const renderAt = yield* Clock.currentTimeMillis;
    parseMs = elapsed(parseAt, renderAt);
    const nextEpoch = followedSheet ? deps.epoch() + 1 : bound.epoch;
    const nextRef = followedSheet ? { ...bound.ref, generation: nextEpoch } : bound.ref;
    const scope = observeScope(
      followedSheet,
      fromSheetId,
      expectedWindowId,
      query !== undefined,
      interactive,
    );
    const observation = yield* Effect.try({
      try: () =>
        observations.renderObservation({
          draft: observations.normalizeAppTree(
            buildObservedDraft({
              targetRef: nextRef,
              generation: nextEpoch,
              state,
              filtered,
              limit,
              shown: tree.shown,
              shownText: tree.shownText,
              omitted,
              nextBounds,
              fallbackTitle: bound.boundWindows?.find((w) => w.window_id === expectedWindowId)
                ?.title,
            }),
          ),
          mode: query ? "query" : "full",
          ...(scope === undefined ? {} : { scope }),
          ...(!capture && args.mode === "diff" ? { resetReason: "desktop_reads_full" } : {}),
          limits: { treeBytes: rawBudget },
        }),
      catch: renderFailure,
    });
    renderMs = elapsed(renderAt, yield* Clock.currentTimeMillis);
    observationId = observation.observationId;
    bound.observationId = observationId;
    if (!capture) {
      delete bound.needsSettleBeforeCapture;
      if (followedSheet && parentId !== undefined) {
        deps.setEpoch(nextEpoch);
        Object.assign(bound, {
          windowId: parentId,
          epoch: nextEpoch,
          ref: nextRef,
          pointsStale: "restart" as const,
        });
        if (nextBounds === undefined) delete bound.windowBounds;
        else bound.windowBounds = nextBounds;
        bound.screenshots?.clear();
        delete bound.latestScreenshot;
      }
      const snapshotId = string(state.snapshot_id);
      if (snapshotId !== undefined) bound.snapshotId = snapshotId;
      // A read its budget cut keeps the rest for observe({after}) until the next read.
      if (observation.elements.length < tree.shown.length)
        bound.pages = {
          base: observation.observationId,
          rows: tree.shown,
          text: tree.shownText,
          given: new Set(observation.elements.map((element) => element.index)),
          ids: new Set(),
        };
      else delete bound.pages;
      const timing = buildObserveTiming({
        startedAt,
        endedAt: yield* Clock.currentTimeMillis,
        driverMs,
        parseMs,
        renderMs,
      });
      return { value: withObserveTiming(observation, timing, rawBudget), category: "unverifiable" };
    }
  }
  if (observationId === undefined) return yield* Effect.fail(fail("downstream_failure"));
  const width = integer(state.screenshot_width);
  const height = integer(state.screenshot_height);
  const shotBounds = boundsOf(object(state.window_bounds));
  if (shotBounds !== undefined) bound.windowBounds = shotBounds;
  // Once shown wrong, the basis stays dropped until the next tree read, even if it matches again.
  if (shotBounds && bound.framesBasis && !sameRect(bound.framesBasis, shotBounds))
    delete bound.framesBasis;
  const captured = buildScreenshotCapture({
    callId: call.callId,
    targetId: bound.ref.id,
    observationId,
    state,
    imagePart: reply.image,
    width,
    height,
  });
  if (!captured) return yield* Effect.fail(fail("downstream_failure"));
  const { metadata, image, shotBasis } = captured;
  observations.index.putRegion(bound.ref.id, observationId, metadata.regionId, {
    ...metadata.region,
    pixelWidth: metadata.pixelWidth,
    pixelHeight: metadata.pixelHeight,
    scale: metadata.scale,
  });
  bound.screenshots ??= new Map();
  bound.screenshots.set(metadata.regionId, shotBasis);
  bound.latestScreenshot = shotBasis;
  delete bound.pointsStale;
  const timing = buildObserveTiming({
    startedAt,
    endedAt: yield* Clock.currentTimeMillis,
    driverMs,
    parseMs,
    renderMs,
  });
  return {
    value: withScreenshotTiming(metadata, timing, context.limits.returnBytes),
    image,
    imageMetadata: metadata,
    category: "unverifiable",
  };
});
