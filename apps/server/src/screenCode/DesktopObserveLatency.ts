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
  ScreenHopTimes,
  ScreenReadPhases,
  ScreenRunError,
} from "@goat/contracts";
import { COMPUTER_USE_PRIMITIVE_RESULT_TOO_LARGE } from "@goat/contracts";
import { driverValue, driverWarnings, fail } from "./DesktopDriverReplies.ts";
import { hopsOf } from "./DesktopHops.ts";
import { settleCaptureIfNeeded } from "./DesktopEvidence.ts";
import { boundsOf, elementFrames, sameRect, windowOrigin } from "./DesktopFrames.ts";
import { inspectTreeElements } from "./DesktopInputGuards.ts";
import {
  beginObservedSheet,
  commitObservedSheet,
  normalizeSheetState,
  resolveObservedSheet,
} from "./DesktopInputPlan.ts";
import {
  boundedReadDetail,
  buildObservedDraft,
  desktopQuery,
  driverQuery,
  framesOmission,
  listedOf,
  observeScope,
  placeInWindow,
  queryOmission,
  READ_BOUNDS,
  renderFailure,
  renderPageObservation,
  screenPlacement,
  type DesktopRow,
} from "./DesktopObserveRead.ts";
import {
  numbersIn,
  stripPartialNote,
  structureProblem,
  treeToDepth,
  treeWithin,
  withChildCounts,
} from "./DesktopObserveDepth.ts";
import {
  canLiftNamesFromTree,
  fastShownTree,
  NAMED_BY_TEXT_ROLES,
  parseDesktopTreeState,
} from "./DesktopTreeState.ts";
import { buildScreenshotCapture, treeWindowBasis } from "./DesktopTargetPoints.ts";
import { checkWindowReplyState, otherWindowsOf, type WindowEntry } from "./DesktopWindows.ts";
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
  readonly hops?: ScreenHopTimes | undefined;
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
      ...(input.hops === undefined ? {} : { hops: input.hops }),
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
  /** The macOS driver's JPEG is under half the PNG's bytes and takes a pixel click all the same. */
  readonly jpeg: boolean;
  readonly modelFit: boolean;
  readonly limit: number;
  readonly filter?: string | undefined;
  readonly since?: string | undefined;
}): Record<string, unknown> => ({
  pid: input.pid,
  window_id: input.windowId,
  include_accessibility_tree: !input.capture,
  include_screenshot: input.capture,
  ...(input.capture && input.jpeg && !input.modelFit ? { screenshot_format: "jpeg" } : {}),
  ...(input.capture && input.modelFit ? { screenshot_fit: "model" } : {}),
  max_elements: input.limit,
  ...(input.capture ? {} : { tree_format: "both" }),
  ...(input.filter === undefined ? {} : { query: input.filter }),
  ...(input.since === undefined ? {} : { since: input.since }),
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

export { canLiftNamesFromTree, fastShownTree };

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
  /** The bound process's windows, read when a Go to Folder sheet may have opened or closed. */
  readonly listWindows: (
    bound: BoundWindow,
    call: ScreenHostCall,
    context: ScreenHostContext,
  ) => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;
  /** The bound process's windows as this cell last listed them, at its bind or after an input. */
  readonly knownWindows: (
    bound: BoundWindow,
    context: ScreenHostContext,
  ) => ReadonlyArray<WindowEntry> | undefined;
  readonly jpegScreenshots: boolean;
  readonly modelFit: boolean;
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
    bound.framesBasis,
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

const keptElements = (state: Record<string, unknown>, numbers: ReadonlySet<number>) =>
  array(state.elements).filter((entry) => {
    const index = natural(object(entry)?.element_index);
    return index !== undefined && numbers.has(index);
  });

/** One element's subtree from the latest whole read, as a page of it: nothing is read again. */
const observeWithin = Effect.fn("DesktopObserveLatency.within")(function* (
  deps: DesktopObserveDeps,
  bound: BoundWindow,
  call: ScreenHostCall,
  context: ScreenHostContext,
  args: Record<string, unknown>,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const index = args.within;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0)
    return yield* Effect.fail(
      fail("invalid_argument", "within takes an element number from the latest observe()."),
    );
  const kept = bound.lastTree;
  if (!kept || kept.base !== bound.observationId || string(args.withinBase) !== kept.base)
    return yield* Effect.fail(
      fail(
        "stale_reference",
        "within reads part of the latest whole read of this window; call observe() or observe({depth}) first.",
      ),
    );
  const problem = structureProblem(
    string(kept.state.tree_markdown) ?? "",
    listedOf(
      array(kept.state.elements)
        .map(object)
        .filter((entry) => entry !== undefined),
    ),
  );
  if (problem !== undefined)
    return yield* Effect.fail(
      fail(
        "unsupported",
        `Part of this read cannot be shown on its own: ${problem}. Use observe({after}) or observe({query}).`,
      ),
    );
  const sub = treeWithin(string(kept.state.tree_markdown) ?? "", index);
  if (sub === undefined)
    return yield* Effect.fail(
      fail("stale_reference", `No [${index}] in the latest read; use a number from observe().`),
    );
  const state = {
    ...kept.state,
    tree_markdown: sub,
    elements: keptElements(kept.state, numbersIn(sub)),
    elements_complete: kept.state.elements_complete === true && !kept.cut,
  };
  const tree = parseDesktopTreeState({
    state,
    filtered: false,
    query: undefined,
    interactive: false,
  });
  const origin = windowOrigin(
    array(kept.state.elements)
      .map(object)
      .filter((entry) => entry !== undefined),
  );
  // Frames stay only while the window is where the read measured it.
  const placedOrigin =
    origin && bound.framesBasis && sameRect(origin, bound.framesBasis) ? origin : undefined;
  const placed = placeInWindow(tree.shown, tree.elements, bound.frames ?? new Map(), placedOrigin);
  const rawBudget = observationReplyBudget(call, context.limits);
  const observation = yield* Effect.try({
    try: () =>
      deps.observations.renderObservation({
        draft: deps.observations.normalizeAppTree(
          buildObservedDraft({
            targetRef: bound.ref,
            generation: bound.epoch,
            state,
            filtered: false,
            limit: READ_BOUNDS[0],
            shown: placed.rows,
            shownText: tree.shownText,
            omitted: framesOmission(placed.dropped),
            screen: screenPlacement(tree.shown, placedOrigin),
            fallbackTitle: undefined,
          }),
        ),
        mode: "query",
        scope: `within [${index}]`,
        page: kept.base,
        limits: { treeBytes: rawBudget },
      }),
    catch: renderFailure,
  });
  if (bound.withinPages?.base !== kept.base)
    bound.withinPages = { base: kept.base, ids: new Set() };
  bound.withinPages.ids.add(observation.observationId);
  const endedAt = yield* Clock.currentTimeMillis;
  const timing = buildObserveTiming({
    startedAt,
    endedAt,
    driverMs: 0,
    parseMs: 0,
    renderMs: elapsed(startedAt, endedAt),
  });
  return {
    value: withObserveTiming(observation, timing, rawBudget),
    category: "unverifiable" as const,
  };
});

/** The driver's diff rows as the model reads them: its header and hints name tokens it never sees. */
const modelDiffRows = (diffText: string) => {
  const lines = diffText.split("\n");
  if (/^since \S+: \d+ added/.test(lines[0] ?? "")) lines.shift();
  if (/^Rows and indices are as before; use snapshot_id/.test(lines.at(-1) ?? "")) lines.pop();
  return lines.join("\n");
};
const structuralDiff = (
  diff: string,
  previous: ReadonlyArray<DesktopRow> | undefined,
  current: ReadonlyArray<DesktopRow>,
) => {
  if (/^(?:[+-] |reindexed:)/m.test(diff)) return true;
  const identity = (row: DesktopRow) => {
    if (row.id) return JSON.stringify([row.role, "id", row.id]);
    return row.pairingTitle ? JSON.stringify([row.role, "title", row.pairingTitle]) : undefined;
  };
  for (const match of diff.matchAll(/^~ \[(\d+)\]/gm)) {
    const index = Number(match[1]);
    const atIndex = current.filter((row) => row.index === index);
    const key = atIndex.length === 1 && atIndex[0] ? identity(atIndex[0]) : undefined;
    if (key === undefined || previous === undefined) return true;
    const old = previous.filter((row) => identity(row) === key);
    if (old.length !== 1 || old[0]?.index !== index) return true;
    if (current.filter((row) => identity(row) === key).length !== 1) return true;
    const selected = atIndex[0];
    if (
      selected &&
      !selected.id &&
      [previous, current].some(
        (rows) =>
          rows.filter((row) => !row.id && row.role === selected.role && row.name === selected.name)
            .length !== 1,
      )
    )
      return true;
  }
  return false;
};

const retainPairingTitles = (
  previous: ReadonlyArray<DesktopRow>,
  current: ReadonlyArray<DesktopRow>,
  diff: string,
) => {
  const changed = new Set([...diff.matchAll(/^~ \[(\d+)\]/gm)].map((match) => Number(match[1])));
  const byIndex = (rows: ReadonlyArray<DesktopRow>) => {
    const result = new Map<number, DesktopRow | undefined>();
    for (const row of rows) {
      if (row.index !== undefined) result.set(row.index, result.has(row.index) ? undefined : row);
    }
    return result;
  };
  const old = byIndex(previous);
  const next = byIndex(current);
  return current.map((row) => {
    if (
      row.pairingTitle ||
      row.index === undefined ||
      changed.has(row.index) ||
      next.get(row.index) !== row
    )
      return row;
    const before = old.get(row.index);
    return before?.pairingTitle &&
      before.role === row.role &&
      before.name === row.name &&
      before.text === row.text &&
      before.id === row.id
      ? { ...row, pairingTitle: before.pairingTitle }
      : row;
  });
};

export const runDesktopObserve = Effect.fn("DesktopObserveLatency.observe")(function* (
  deps: DesktopObserveDeps,
  bound: BoundWindow,
  call: ScreenHostCall,
  context: ScreenHostContext,
  args: Record<string, unknown>,
): Effect.fn.Return<ScreenHostDispatchResult, ScreenRunError> {
  const { observations } = deps;
  const capture = call.method === "screenshot";
  if (!capture && args.within !== undefined)
    return yield* observeWithin(deps, bound, call, context, args);
  const depth = capture ? undefined : args.depth;
  if (
    depth !== undefined &&
    (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > 10)
  )
    return yield* Effect.fail(fail("invalid_argument", "depth is a whole number from 1 to 10."));
  // Any read starts the tree baseline over; only a whole read below sets it again.
  delete bound.fullRows;
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
  const baseObservationId = string(args.baseObservationId);
  const textNamedBaseline = bound.rows?.some((row) => row.lifted === true) === true;
  const since =
    !capture &&
    !query &&
    args.interactiveOnly !== true &&
    args.mode === "diff" &&
    bound.diffBaseline === true &&
    bound.fullObservationId !== undefined &&
    baseObservationId === bound.observationId
      ? bound.snapshotId
      : undefined;
  let retired = false;
  const warnings: string[] = [];
  let readWindow = bound.windowId;
  const read = Effect.fn("DesktopObserveLatency.read")(function* (
    limit: number,
    filter?: string,
    windowId = readWindow,
    allowDiff = true,
  ) {
    const sentAt = yield* Clock.currentTimeMillis;
    const reply = yield* deps.boundRequest(
      bound,
      "nothing",
      "get_window_state",
      buildDesktopReadArgs({
        pid: bound.pid,
        windowId,
        capture,
        jpeg: deps.jpegScreenshots,
        modelFit: deps.modelFit,
        limit,
        filter,
        since:
          allowDiff &&
          !retired &&
          windowId === bound.windowId &&
          limit === READ_BOUNDS[0] &&
          filter === undefined
            ? since
            : undefined,
      }),
      call,
      context,
    );
    driverMs += elapsed(sentAt, yield* Clock.currentTimeMillis);
    for (const warning of driverWarnings(reply, "read"))
      if (!warnings.includes(warning) && warnings.length < 4) warnings.push(warning);
    return reply;
  });
  // A read that ran retired the driver's earlier tokens, so their refs go even when its
  // answer is unusable; only a driver naming another window makes the binding stale.
  const retire = () => {
    retired = true;
    observations.evictTarget(bound.ref.id);
    delete bound.observationId;
    delete bound.snapshotId;
    delete bound.diffBaseline;
    delete bound.fullObservationId;
    delete bound.structuralDiff;
    delete bound.lastReadCut;
    delete bound.pages;
    delete bound.elementsByToken;
    delete bound.rows;
    delete bound.fullRows;
    delete bound.lastTree;
  };
  let limit: number = READ_BOUNDS[0];
  yield* settleCaptureIfNeeded(capture, bound, call.deadlineMillis);
  const list = deps.listWindows(bound, call, context);
  const begun = yield* beginObservedSheet(bound, capture, list, call.deadlineMillis);
  readWindow = begun.readWindowId;
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
  const retiredBeforeSheet = retired;
  const sheet = yield* resolveObservedSheet({
    bound,
    capture,
    reply,
    retire,
    list,
    filtered,
    verify: verifyReply,
    ...begun,
    deadlineMillis: call.deadlineMillis,
    read: (windowId) => read(limit, filtered ? search : undefined, windowId),
  });
  ({ reply } = sheet);
  let { state } = sheet;
  const { followedSheet, expectedWindowId } = sheet;
  const status = string(state.since_status);
  const needsFullForNames =
    since !== undefined &&
    !followedSheet &&
    (status === "diff" || status === "no_change") &&
    array(state.elements).some((item) => {
      const entry = object(item);
      return (
        entry !== undefined &&
        NAMED_BY_TEXT_ROLES.includes(string(entry.role) ?? "") &&
        string(entry.element_token) !== undefined &&
        string(entry.label) === undefined
      );
    });
  const tooManyMoved = (string(state.tree_diff) ?? "").includes(
    "reindexed: more shifted ranges not listed",
  );
  const missingDiffBase =
    (status === "diff" || status === "no_change") &&
    (retired || bound.fullObservationId === undefined || baseObservationId === undefined);
  if (needsFullForNames || tooManyMoved || missingDiffBase) {
    retire();
    reply = yield* read(limit, undefined, expectedWindowId, false);
    state = normalizeSheetState(yield* verifyReply(object(driverValue(reply)), expectedWindowId));
    if (state.since_status === "diff" || state.since_status === "no_change")
      return yield* Effect.fail(fail("downstream_failure", "The full read returned a diff."));
  }
  const fromSheetId = bound.windowId;
  const interactive = !capture && args.interactiveOnly === true;
  const nextBounds = followedSheet
    ? (boundsOf(state.window_bounds) ??
      bound.boundWindows?.find((w) => w.window_id === expectedWindowId)?.bounds)
    : bound.windowBounds;
  // The app's other windows on screen, such as a chat an input opened, as this cell listed them.
  const otherWindows = capture
    ? []
    : otherWindowsOf(deps.knownWindows(bound, context), [bound.windowId, expectedWindowId]);
  const warningBytes =
    (warnings.length ? Buffer.byteLength(JSON.stringify({ warnings })) : 0) +
    (otherWindows.length ? Buffer.byteLength(JSON.stringify({ otherWindows })) : 0);
  const rawBudget = observationReplyBudget(call, context.limits, warningBytes);
  // A screenshot-only read that kept the tree's driver snapshot keeps its tokens, so the tree's
  // observation, rows and frames stay and the reply's tree is not read at all. Any other read
  // has retired them in the driver, so the old refs go now, before a render that may fail.
  const kept = keptScreenshotObservationId(capture, bound, state);
  let observationId = kept;
  if (kept === undefined) {
    const parseAt = yield* Clock.currentTimeMillis;
    const currentStatus = string(state.since_status);
    const diffText = string(state.tree_diff);
    const isDiff =
      !needsFullForNames &&
      !tooManyMoved &&
      !missingDiffBase &&
      !retired &&
      bound.fullObservationId !== undefined &&
      baseObservationId !== undefined &&
      since !== undefined &&
      !followedSheet &&
      (currentStatus === "diff" || currentStatus === "no_change") &&
      diffText !== undefined;
    const fallbackReason =
      args.mode !== "diff" || isDiff
        ? undefined
        : tooManyMoved
          ? "full read: too many rows moved"
          : needsFullForNames ||
              (since === undefined &&
                baseObservationId === bound.observationId &&
                textNamedBaseline)
            ? "full read: rows named by their text"
            : followedSheet
              ? "full read: window changed"
              : retired && !retiredBeforeSheet
                ? "full read: sheet probe retired the previous observation"
                : since === undefined
                  ? baseObservationId === bound.observationId
                    ? bound.lastReadCut
                      ? "full read: the last read was cut"
                      : "full read: scope changed"
                    : "full read: observation expired"
                  : currentStatus === "unknown_snapshot"
                    ? "full read: snapshot expired"
                    : `full read: ${(currentStatus ?? "diff unavailable").replaceAll("_", " ")}`;
    const rows = isDiff ? modelDiffRows(diffText) : "";
    const focus =
      currentStatus === "no_change"
        ? (diffText?.match(/; focused element is \[\d+\]/)?.[0] ?? "")
        : "";
    const raw = stripPartialNote(string(state.tree_markdown) ?? "");
    let treeState = state;
    let depthCut: ReturnType<typeof treeToDepth> | undefined;
    if (depth !== undefined) {
      const problem = isDiff
        ? "it came back as a diff"
        : structureProblem(
            raw.tree,
            listedOf(
              array(state.elements)
                .map(object)
                .filter((entry) => entry !== undefined),
            ),
          );
      if (problem !== undefined) {
        retire();
        return yield* Effect.fail(
          fail(
            "unsupported",
            `This window was read, but ${problem}, so it cannot be shown by depth. Use observe(), observe({after}) or observe({query}).`,
          ),
        );
      }
      depthCut = treeToDepth(raw.tree, depth);
      treeState = {
        ...state,
        tree_markdown: depthCut.text,
        elements: keptElements(state, numbersIn(depthCut.text)),
        elements_complete: state.elements_complete === true && !depthCut.dropped && !raw.cut,
      };
    }
    const tree = parseDesktopTreeState({ state: treeState, filtered, query, interactive });
    // A depth read shows part of the window, but guards, frames and named actions cover all of it,
    // so an element first shown by observe({within}) is checked like one from a whole read.
    const whole = depthCut ? parseDesktopTreeState({ state, filtered, query, interactive }) : tree;
    const treeText = depthCut
      ? withChildCounts(tree.shownText, depthCut.counts, raw.cut || state.truncated === true)
      : tree.shownText;
    const numbersChanged =
      isDiff && (bound.structuralDiff === true || structuralDiff(rows, bound.rows, tree.rows));
    bound.frames = elementFrames(whole.elements);
    // The agent reads frames in window points; internal geometry stays in the driver's screen points.
    const origin = windowOrigin(whole.elements);
    const placed = placeInWindow(tree.shown, tree.elements, bound.frames, origin);
    const omitted = [
      ...(query
        ? queryOmission(state, tree.shown.length, filtered)
        : limit < READ_BOUNDS[0]
          ? [{ kind: "budget" as const, detail: boundedReadDetail(limit) }]
          : []),
      ...sheet.extraOmitted,
      ...framesOmission(placed.dropped),
    ];
    // The read's own window frame, when it has one, is where its elements were measured.
    const screen = screenPlacement(tree.shown, origin ?? nextBounds);
    observations.evictTarget(bound.ref.id);
    delete bound.observationId;
    delete bound.snapshotId;
    bound.rows =
      isDiff && !numbersChanged && bound.rows
        ? retainPairingTitles(bound.rows, tree.shown, rows)
        : whole.shown;
    // Only a whole read compares: a cut, filtered or degraded one drops rows the window still has.
    if (
      !capture &&
      query === undefined &&
      depth === undefined &&
      !interactive &&
      !filtered &&
      state.truncated !== true &&
      state.degraded !== true &&
      limit === READ_BOUNDS[0] &&
      bound.rows.length > 0
    )
      bound.fullRows = {
        rows: bound.rows,
        windowId: expectedWindowId,
        connectionGeneration: bound.connectionGeneration,
      };
    bound.elementsByToken = inspectTreeElements(
      whole.elements,
      whole.rows,
      whole.markdown,
      typeof state.tree_markdown === "string" ? state.tree_markdown : undefined,
    );
    const basis = treeWindowBasis(bound.frames, nextBounds);
    if (basis === undefined) delete bound.framesBasis;
    else bound.framesBasis = basis;
    const renderAt = yield* Clock.currentTimeMillis;
    parseMs = elapsed(parseAt, renderAt);
    const nextEpoch = followedSheet ? deps.epoch() + 1 : bound.epoch;
    const nextRef = followedSheet ? { ...bound.ref, generation: nextEpoch } : bound.ref;
    const scope =
      depth !== undefined
        ? `${observeScope(followedSheet, fromSheetId, expectedWindowId, false, false) ?? "window"} depth ${depth}`
        : observeScope(
            followedSheet,
            fromSheetId,
            expectedWindowId,
            query !== undefined,
            interactive,
          );
    const snapshotId = string(state.snapshot_id);
    const snapshotBudget =
      snapshotId === undefined ? 0 : Buffer.byteLength(JSON.stringify(snapshotId)) + 12;
    const observation = yield* Effect.try({
      try: () =>
        observations.renderObservation({
          draft: observations.normalizeAppTree(
            buildObservedDraft({
              targetRef: nextRef,
              generation: nextEpoch,
              state: treeState,
              filtered,
              limit,
              shown: placed.rows,
              shownText: isDiff
                ? currentStatus === "no_change"
                  ? numbersChanged
                    ? `no change since ${baseObservationId}; numbers as in that observation${focus}`
                    : `no change; numbers unchanged${focus}`
                  : numbersChanged
                    ? `${rows}\nother numbers unchanged since ${baseObservationId}; observe({diff:false}) lists every current number`
                    : `${rows}\nother numbers unchanged; latest full observation is ${bound.fullObservationId}`
                : treeText,
              omitted,
              screen,
              fallbackTitle: bound.boundWindows?.find((w) => w.window_id === expectedWindowId)
                ?.title,
            }),
          ),
          mode: query ? "query" : isDiff ? "diff" : "full",
          ...(isDiff && baseObservationId !== undefined
            ? { prediffed: true, baseObservationId }
            : {}),
          ...(scope === undefined ? {} : { scope }),
          ...(fallbackReason === undefined ? {} : { resetReason: fallbackReason }),
          limits: { treeBytes: Math.max(0, rawBudget - snapshotBudget) },
        }),
      catch: renderFailure,
    });
    renderMs = elapsed(renderAt, yield* Clock.currentTimeMillis);
    observationId = observation.observationId;
    bound.observationId = observationId;
    if (!capture) {
      delete bound.needsSettleBeforeCapture;
      if (followedSheet) deps.setEpoch(nextEpoch);
      commitObservedSheet(bound, sheet, nextRef, nextBounds);
      if (snapshotId !== undefined) bound.snapshotId = snapshotId;
      bound.lastReadCut =
        query === undefined && depth === undefined && !interactive && observation.truncated;
      bound.diffBaseline =
        query === undefined &&
        depth === undefined &&
        !interactive &&
        !observation.truncated &&
        !tree.shown.some((row) => row.lifted === true);
      if (!bound.diffBaseline) {
        delete bound.fullObservationId;
        delete bound.structuralDiff;
      } else if (!isDiff) {
        bound.fullObservationId = observationId;
        delete bound.structuralDiff;
      } else if (numbersChanged) bound.structuralDiff = true;
      // A read its budget cut keeps the rest for observe({after}) until the next read.
      if (observation.elements.length < tree.shown.length)
        bound.pages = {
          base: observation.observationId,
          rows: placed.rows,
          text: treeText,
          given: new Set(observation.elements.map((element) => element.index)),
          ids: new Set(),
          ...(origin === undefined ? {} : { origin }),
          dropped: placed.dropped,
          screen,
        };
      else delete bound.pages;
      // A whole read keeps its raw tree so observe({within}) can show part of it without reading.
      if (!isDiff && !filtered && query === undefined && !interactive && raw.tree.trim() !== "")
        bound.lastTree = {
          base: observationId,
          state: { ...state, tree_markdown: raw.tree },
          cut: raw.cut || state.truncated === true,
        };
      else delete bound.lastTree;
      const timing = buildObserveTiming({
        startedAt,
        endedAt: yield* Clock.currentTimeMillis,
        driverMs,
        parseMs,
        renderMs,
        ...(args.debug === true ? { hops: hopsOf(call) } : {}),
      });
      return {
        value: withObserveTiming(
          {
            ...observation,
            ...(snapshotId === undefined ? {} : { snapshot: snapshotId }),
            ...(warnings.length ? { warnings } : {}),
            ...(otherWindows.length ? { otherWindows } : {}),
          },
          timing,
          rawBudget,
        ),
        category: "unverifiable",
      };
    }
  }
  if (kept === undefined) {
    delete bound.diffBaseline;
    delete bound.fullObservationId;
    delete bound.structuralDiff;
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
    window: { pid: bound.pid, windowId: bound.windowId },
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
    ...(args.debug === true ? { hops: hopsOf(call) } : {}),
  });
  return {
    value: withScreenshotTiming(metadata, timing, context.limits.returnBytes),
    image,
    imageMetadata: metadata,
    category: "unverifiable",
  };
});
