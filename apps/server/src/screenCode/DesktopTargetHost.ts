// @effect-diagnostics preferSchemaOverJson:off - Driver replies are bounded by the primitive channel.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HostProcess from "@goat/shared/HostProcess";
import type {
  ComputerUseOverlayPoint,
  ScreenHostCall,
  ScreenRunError,
  ScreenTargetRef,
} from "@goat/contracts";
import {
  COMPUTER_USE_PRIMITIVE_ARGS_BYTES,
  COMPUTER_USE_PRIMITIVE_RESULT_TOO_LARGE,
  EnvironmentId,
} from "@goat/contracts";
import { driverOutcomeSafety } from "../cua/ComputerUseDriverOutcome.ts";
import type { ComputerUsePrimitiveChannel } from "../cua/ComputerUsePrimitiveChannel.ts";
import type { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import type { ScreenCellRef, ScreenTargetLabel } from "../cua/ComputerUseCallApps.ts";
import type {
  ScreenHostContext,
  ScreenHostDispatcher,
  ScreenHostDispatchResult,
} from "./ScreenHostBridge.ts";
import { observationReplyBudget } from "./ScreenHostBridge.ts";
import { dispatchInTurn } from "./ScreenBatchGroups.ts";
import { CELL_RESERVE_MS } from "../cua/ComputerUseCallCaps.ts";
import { driverError, driverResult, driverValue, fail } from "./DesktopDriverReplies.ts";
import { ScreenObservations } from "./ScreenObservations.ts";
import { makeBindWindow, makeLaunch } from "./DesktopLaunch.ts";
import {
  BATCH_FAILED_CATEGORIES,
  inspectTreeElements,
  preflightDesktopBatch,
  type GuardElement,
} from "./DesktopInputGuards.ts";
import {
  aimOf,
  boundsOf,
  elementFrames,
  sameRect,
  type Placed,
  type Rect,
} from "./DesktopFrames.ts";
import {
  annotatePointerResult,
  applyDesktopPointerArgs,
  buildScreenshotCapture,
  pointerStateFor,
  treeWindowBasis,
  type ScreenshotBasis,
} from "./DesktopTargetPoints.ts";
import {
  finishCellTracker,
  pollHiddenWindow,
  runInputWithEvidence,
  seedBatchBaseline,
  settleCaptureIfNeeded,
} from "./DesktopEvidence.ts";
import {
  availabilityFromControlState,
  buildWaitExpectation,
  inspectBatchMember,
  INPUT_METHODS,
  prepareDesktopInput,
  validateMenuInput,
} from "./DesktopInputPlan.ts";
import {
  CellWindowTracker,
  checkWindowReplyState,
  type CellWindowsOutcome,
  matchBindWindow,
  parseWindowList,
  sheetParentId,
  type WindowEntry,
} from "./DesktopWindows.ts";
import { isInteractive, keepTreeLines } from "./DesktopTreeText.ts";
import {
  boundedReadDetail,
  buildObservedDraft,
  desktopQuery,
  desktopRows,
  driverQuery,
  matchesQuery,
  observeScope,
  renderPageObservation,
  queryOmission,
  renderFailure,
  shownTree,
  treeOf,
  READ_BOUNDS,
  type DesktopPages,
  type DesktopRow,
} from "./DesktopObserveRead.ts";
import { makeMenuBarExtras, makeSelectText } from "./DesktopSelectionExtras.ts";

const isJson = Schema.is(Schema.Json);
/** Whether args fit the primitive channel's byte cap, measured as its schema measures them. */
const withinPrimitiveCap = (args: Record<string, unknown>) =>
  new TextEncoder().encode(JSON.stringify(args)).byteLength <= COMPUTER_USE_PRIMITIVE_ARGS_BYTES;

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
// Strip guest-only targetRef/batch fields before forwarding arguments to the driver.
const callArgs = (args: ScreenHostCall["args"]): Record<string, unknown> => {
  const { targetRef: _t, batch: _b, ...rest } = object(Array.isArray(args) ? args[0] : args) ?? {};
  return rest;
};
const array = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const RESTARTED_POINTS = "The driver restarted; take a new screenshot before using [x, y] pixels.";
const RESTARTED_ELEMENTS = "The driver restarted; observe again to get current element numbers.";
export interface BoundWindow {
  ref: ScreenTargetRef;
  readonly pid: number;
  windowId: number;
  readonly appId: string;
  /** The bundle id list_apps gave the app; a run_steps app_scope names the app by it. */
  readonly bundleId?: string;
  readonly controlId: string;
  epoch: number;
  /** The driver generation the window was bound under; a rebind after a replacement moves it. */
  connectionGeneration: string;
  observationId?: string;
  /** The rest of the read behind observationId, when its budget cut it; see DesktopPages. */
  pages?: DesktopPages;
  /** Rows of the current observation and its pages, for watched-element evidence and action checks. */
  rows?: ReadonlyArray<DesktopRow>;
  boundWindows?: ReadonlyArray<WindowEntry> | undefined;
  boundInCellId?: string | undefined;
  /** The driver snapshot behind observationId; a screenshot that keeps it keeps the tree's refs. */
  snapshotId?: string;
  /** Input went to the window, or a new driver replaced the one that took its latest screenshot. */
  pointsStale?: "input" | "restart";
  /** Input ran without a post-input 60 ms settle sleep; the next screenshot settles first. */
  needsSettleBeforeCapture?: boolean;
  /** Element frames from the tree behind observationId, by driver token. */
  frames?: ReadonlyMap<string, Placed>;
  /** Element roles, labels and table-cell ancestry from the tree behind observationId. */
  elementsByToken?: ReadonlyMap<string, GuardElement>;
  /** Set when the previous input on this window clicked a table cell. */
  lastClickedTableCell?: number | string;
  /** The window bounds held when those frames were read, until a screenshot shows them wrong. */
  framesBasis?: Rect;
  screenshots?: Map<string, ScreenshotBasis>;
  latestScreenshot?: ScreenshotBasis;
  /**
   * The window's screen bounds from its binding or latest screenshot. They place a tree that
   * leaves the window out (macOS indexes only actionable elements); a tree read returns none.
   */
  windowBounds?: Rect;
}

type DesktopMethod = (
  call: ScreenHostCall,
  context: ScreenHostContext,
) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;

export interface DesktopTargetHost extends ScreenHostDispatcher {
  readonly discover: DesktopMethod;
  readonly bindApp: DesktopMethod;
  readonly observe: DesktopMethod;
  readonly invoke: DesktopMethod;
  readonly invalidateTarget: (targetId: string) => void;
  readonly matchesControl: (targetId: string, controlId: string, windowId?: number) => boolean;
  readonly controlIdForTarget: (targetId: string) => string | undefined;
  readonly windowForTarget?: (
    id: string,
  ) => { readonly pid: number; readonly windowId: number } | undefined;
  readonly setCursorGeneration?: (
    lookup: (ref: ScreenTargetRef, callKey?: string) => number,
  ) => void;
  readonly finishTurn: (runId: string, turnId: string) => void;
  readonly finishCell?: (
    context: ScreenHostContext,
    options?: { readonly skipEndRead?: boolean; readonly cellDeadlineMillis?: number },
  ) => Effect.Effect<CellWindowsOutcome>;
}

export const createDesktopTargetHost = (deps: {
  readonly primitiveChannel: ComputerUsePrimitiveChannel["Service"];
  readonly leases: ComputerUseLeases["Service"];
  readonly observations?: ScreenObservations;
  readonly platform?: NodeJS.Platform;
  /** Names the app a target id was bound to, for the cell's timeline row. */
  readonly labelTarget?: (targetId: string, label: ScreenTargetLabel, cell: ScreenCellRef) => void;
  readonly cursorGeneration?: (ref: ScreenTargetRef, callKey?: string) => number;
}): DesktopTargetHost => {
  const observations = deps.observations ?? new ScreenObservations();
  const isMac = (deps.platform ?? HostProcess.Platform.defaultValue()) === "darwin";
  const targets = new Map<string, BoundWindow>();
  const cellTrackers = new Map<
    string,
    { tracker: CellWindowTracker; connectionGeneration: string }
  >();
  const cellKey = (c: {
    readonly runId: string;
    readonly turnId: string;
    readonly cellId: string;
  }) => `${c.runId}\u0000${c.turnId}\u0000${c.cellId}`;
  const trackerFor = (context: ScreenHostContext, connectionGeneration: string) => {
    const key = cellKey(context);
    let entry = cellTrackers.get(key);
    if (!entry) {
      entry = { tracker: new CellWindowTracker(), connectionGeneration };
      cellTrackers.set(key, entry);
    }
    return entry.tracker;
  };
  let epoch = 0;
  let cursorGeneration = deps.cursorGeneration;
  /** One driver call and its reply as the driver gave it; GOAT's own refusals come back as replies. */
  const send = Effect.fn("DesktopTargetHost.send")(function* (
    tool: string,
    args: Record<string, unknown>,
    call: ScreenHostCall,
    context: ScreenHostContext,
    expectedConnectionGeneration?: string,
    /** The input's cursor: the bound target that owns it and, for an element, its center. */
    cursor?: {
      readonly bound: BoundWindow;
      readonly point?: ComputerUseOverlayPoint | undefined;
      readonly optional?: boolean;
    },
  ) {
    if (!isJson(args) || !withinPrimitiveCap(args))
      return yield* Effect.fail(fail("invalid_argument"));
    return yield* deps.primitiveChannel.request({
      threadId: context.invocation.thread.threadId,
      runId: context.runId,
      turnId: context.turnId,
      callId: call.callId,
      deadlineMillis: call.deadlineMillis,
      tool,
      args,
      ...(expectedConnectionGeneration === undefined ? {} : { expectedConnectionGeneration }),
      ...(cursor === undefined
        ? {}
        : {
            cursor: {
              owner: {
                environmentId: EnvironmentId.make(cursor.bound.ref.environmentId),
                runId: cursor.bound.ref.runId,
                turnId: cursor.bound.ref.turnId,
                targetId: cursor.bound.ref.id,
                generation:
                  cursorGeneration?.(cursor.bound.ref, `${context.cellId}\u0000${call.callId}`) ??
                  cursor.bound.ref.generation,
                sequence: 0,
              },
              ...(cursor.point === undefined ? {} : { point: cursor.point }),
            },
          }),
    });
  });
  const request = Effect.fn("DesktopTargetHost.request")(function* (
    ...input: Parameters<typeof send>
  ) {
    const tool = input[0];
    const reply = yield* send(...input);
    const safety = driverOutcomeSafety(tool, reply);
    const error = driverError(reply);
    if (error) {
      return yield* Effect.fail({ ...error, safety, effectStarted: safety.possibleCommit });
    }
    return reply;
  });
  const resolve = (call: ScreenHostCall, context: ScreenHostContext) => {
    const ref = call.targetRef;
    const bound = ref && targets.get(ref.id);
    return ref?.kind === "app" &&
      bound &&
      ref.environmentId === context.environmentId &&
      ref.runId === context.runId &&
      ref.turnId === context.turnId &&
      ref.generation === bound.epoch
      ? bound
      : undefined;
  };
  /**
   * A call on a bound window. After a driver replacement the channel refuses the old generation
   * before sending: a call that needs nothing of the old driver rebinds the window once and goes
   * again, while its points and element numbers are refused with what to do instead.
   */
  const boundRequest = Effect.fn("DesktopTargetHost.boundRequest")(function* (
    bound: BoundWindow,
    needs: "nothing" | "points" | "element",
    tool: string,
    args: Record<string, unknown>,
    call: ScreenHostCall,
    context: ScreenHostContext,
    cursor?: Parameters<typeof send>[5],
  ) {
    const first = yield* request(
      tool,
      args,
      call,
      context,
      bound.connectionGeneration,
      cursor,
    ).pipe(Effect.result);
    if (first._tag === "Success") return first.success;
    // Only the channel's own generation check fails without the driver's safety label.
    if (first.failure.code !== "stale_reference" || first.failure.safety !== undefined)
      return yield* Effect.fail(first.failure);
    if (needs !== "nothing")
      return yield* Effect.fail(
        fail("stale_reference", needs === "points" ? RESTARTED_POINTS : RESTARTED_ELEMENTS),
      );
    const listed = yield* request("list_windows", { pid: bound.pid }, call, context);
    const still = array(object(driverValue(listed))?.windows)
      .map(object)
      .some((window) => window?.window_id === bound.windowId && window.pid === bound.pid);
    if (!still) return yield* Effect.fail(first.failure);
    bound.connectionGeneration = listed.connectionGeneration;
    // The new driver holds none of the old one's snapshots or screenshots.
    observations.evictTarget(bound.ref.id);
    delete bound.observationId;
    delete bound.snapshotId;
    delete bound.pages;
    delete bound.elementsByToken;
    bound.screenshots?.clear();
    delete bound.latestScreenshot;
    bound.pointsStale = "restart";
    return yield* request(tool, args, call, context, bound.connectionGeneration, cursor);
  });
  /** The driver token behind an element ref of the bound window's latest observation. */
  const tokenOf = (element: Record<string, unknown>, bound: BoundWindow) => {
    const ref = {
      id: string(element.id) ?? "",
      targetId: string(element.targetId) ?? "",
      observationId: string(element.observationId) ?? "",
      surfaceGeneration: element.surfaceGeneration,
    };
    const page =
      bound.pages?.base === bound.observationId && bound.pages?.ids.has(ref.observationId);
    return ref.targetId === bound.ref.id &&
      (ref.observationId === bound.observationId || page === true) &&
      ref.surfaceGeneration === bound.epoch
      ? observations.index.resolveElement(
          ref as Parameters<typeof observations.index.resolveElement>[0],
        )
      : undefined;
  };
  const discover: DesktopTargetHost["discover"] = Effect.fn("DesktopTargetHost.discover")(
    function* (call, context) {
      if (call.method !== "list_apps" && call.method !== "list_windows")
        return yield* Effect.fail(fail("unsupported"));
      const args = callArgs(call.args);
      const reply = yield* request(
        call.method,
        call.method === "list_windows" && integer(args.pid) ? { pid: args.pid } : {},
        call,
        context,
      );
      return { value: driverValue(reply), category: "unverifiable" };
    },
  );
  const bindApp: DesktopTargetHost["bindApp"] = Effect.fn("DesktopTargetHost.bindApp")(
    function* (call, context) {
      const args = callArgs(call.args);
      const bundleId = string(args.bundle_id) ?? string(args.bundleId);
      const name = string(args.name);
      const appId = bundleId ?? name;
      const requestedWindow = integer(args.window_id) ?? integer(args.windowId);
      if (!appId || !requestedWindow) return yield* Effect.fail(fail("invalid_argument"));
      const appsReply = yield* request("list_apps", {}, call, context);
      const listed = object(driverValue(appsReply))?.apps;
      const matches = array(listed)
        .map(object)
        .filter((app) => app !== undefined)
        .filter((app) => (bundleId ? app.bundle_id === bundleId : app.name === name));
      const pids = new Set(matches.map((app) => integer(app.pid)));
      pids.delete(undefined);
      if (Array.isArray(listed) && pids.size === 0)
        return yield* Effect.fail(fail("target_missing"));
      const [onlyPid] = pids.size === 1 ? pids : [];
      // Linux lists every process and launcher, which can pass the lease proxy's reply cap; the
      // driver's `app` filter (bundle id equal, or name contained) then narrows the windows. It
      // also finds the window among several processes of one app.
      const windowsReply = yield* request(
        "list_windows",
        onlyPid ? { pid: onlyPid } : { app: appId },
        call,
        context,
        appsReply.connectionGeneration,
      );
      if (windowsReply.connectionGeneration !== appsReply.connectionGeneration)
        return yield* Effect.fail(fail("stale_reference"));
      const matched = matchBindWindow(
        listed,
        object(driverValue(windowsReply))?.windows,
        bundleId,
        name,
        requestedWindow,
        matches,
        pids,
      );
      if (matched.error || !matched.pid || !matched.window)
        return yield* Effect.fail(matched.error ?? fail("target_missing"));
      const { pid, app, window: foundWin } = matched;
      const current = Option.getOrUndefined(
        yield* deps.leases.currentControl(context.invocation.thread.threadId),
      );
      if (!current) return yield* Effect.fail(fail("unavailable"));
      const ref = bindWindow(
        {
          pid,
          windowId: requestedWindow,
          bundleId: string(app?.bundle_id),
          name: string(app?.name) ?? string(foundWin.app_name),
          appId: string(app?.bundle_id) ?? string(app?.name) ?? appId,
          iconBundleId: bundleId,
          bounds: foundWin.bounds,
          connectionGeneration: windowsReply.connectionGeneration,
          controlId: current.controlId,
        },
        context,
      );
      const created = targets.get(ref.id);
      if (created) {
        created.boundWindows = parseWindowList(driverValue(windowsReply), pid);
        created.boundInCellId = context.cellId;
      }
      return { value: ref, category: "unverifiable" };
    },
  );
  const bindWindow = makeBindWindow({
    targets,
    evict: (id) => observations.evictTarget(id),
    nextEpoch: () => ++epoch,
    labelTarget: deps.labelTarget,
  });
  const launch = makeLaunch({
    platform: deps.platform,
    request,
    leases: deps.leases,
    bind: bindWindow,
  });
  const selectText = makeSelectText({ send, tokenOf });
  const menuBarExtras = makeMenuBarExtras({ send });
  /** The next part of a read its budget cut, from the elements it already holds: no driver call. */
  const page = Effect.fn("DesktopTargetHost.page")(function* (
    bound: BoundWindow,
    call: ScreenHostCall,
    context: ScreenHostContext,
  ) {
    const res = renderPageObservation(
      observations,
      bound.pages,
      bound.observationId,
      bound.ref,
      bound.epoch,
      bound.windowBounds,
      callArgs(call.args),
      observationReplyBudget(call, context.limits),
    );
    if (res.error || !res.observation)
      return yield* Effect.fail(res.error ?? fail("downstream_failure"));
    return { value: res.observation, category: "unverifiable" as const };
  });
  const observe: DesktopTargetHost["observe"] = Effect.fn("DesktopTargetHost.observe")(
    function* (call, context) {
      const bound = resolve(call, context);
      if (!bound) return yield* Effect.fail(fail("stale_reference"));
      if (
        !["get_window_state", "get_accessibility_tree", "verify_state", "screenshot"].includes(
          call.method,
        )
      )
        return yield* Effect.fail(fail("unsupported"));
      const capture = call.method === "screenshot";
      const args = callArgs(call.args);
      if (!capture && args.after !== undefined) return yield* page(bound, call, context);
      const query = !capture && args.mode === "query" ? desktopQuery(args.query) : undefined;
      if (!capture && args.mode === "query" && !query)
        return yield* Effect.fail(
          fail("invalid_argument", "Query by {role, name, text, id}: name at least one."),
        );
      const search = query && driverQuery(query);
      // A driver diff (`since`) keeps only changed rows and retires the others' tokens, and
      // goat.7 fails its own count check on it, so every desktop read is full: all refs stay usable.
      const read = (limit: number, filter?: string, windowId = bound.windowId) =>
        boundRequest(
          bound,
          "nothing",
          "get_window_state",
          {
            pid: bound.pid,
            window_id: windowId,
            include_accessibility_tree: !capture,
            include_screenshot: capture,
            max_elements: limit,
            ...(capture ? {} : { tree_format: "both" }),
            ...(filter === undefined ? {} : { query: filter }),
          },
          call,
          context,
        );
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
        if (checked.evictTarget) targets.delete(bound.ref.id);
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
      const elements = array(state.elements)
        .map(object)
        .filter((entry) => entry !== undefined);
      const markdown = treeOf(state, elements, filtered);
      const rows = desktopRows(elements, markdown);
      // An interactive-only read keeps controls, fields, disabled controls and named rows, and
      // spends the reply budget on them alone; a query keeps the elements matching every field.
      const interactive = !capture && args.interactiveOnly === true;
      const shown = query
        ? rows.filter((row) => matchesQuery(row, query))
        : interactive
          ? rows.filter(isInteractive)
          : rows;
      const treeText = shownTree(markdown, filtered ? undefined : elements);
      const shownText =
        query || interactive
          ? keepTreeLines(
              treeText,
              new Set(shown.flatMap((row) => (row.index === undefined ? [] : [row.index]))),
            )
          : treeText;
      const omitted = query
        ? queryOmission(state, shown.length, filtered)
        : limit < READ_BOUNDS[0]
          ? [{ kind: "budget" as const, detail: boundedReadDetail(limit) }]
          : [];
      // A screenshot-only read that kept the tree's driver snapshot keeps its tokens, so the
      // tree's observation stays and only gains this region. Any other read has retired them in
      // the driver, so the old refs go now, before a render that may fail.
      const invalidated = array(state.invalidated_snapshot_ids);
      const kept =
        capture &&
        bound.snapshotId !== undefined &&
        string(state.snapshot_id) === bound.snapshotId &&
        !invalidated.includes(bound.snapshotId)
          ? bound.observationId
          : undefined;
      const nextBounds = followedSheet
        ? (boundsOf(state.window_bounds) ??
          bound.boundWindows?.find((w) => w.window_id === expectedWindowId)?.bounds)
        : bound.windowBounds;
      const fallbackTitle = bound.boundWindows?.find(
        (w) => w.window_id === expectedWindowId,
      )?.title;
      if (kept === undefined) {
        observations.evictTarget(bound.ref.id);
        delete bound.observationId;
        delete bound.snapshotId;
        bound.rows = shown;
        bound.frames = elementFrames(elements);
        bound.elementsByToken = inspectTreeElements(elements, rows);
        const basis = treeWindowBasis(bound.frames, nextBounds);
        if (basis === undefined) delete bound.framesBasis;
        else bound.framesBasis = basis;
      }
      const nextEpoch = followedSheet ? epoch + 1 : bound.epoch;
      const nextRef = followedSheet ? { ...bound.ref, generation: nextEpoch } : bound.ref;
      const scope = observeScope(
        followedSheet,
        fromSheetId,
        expectedWindowId,
        query !== undefined,
        interactive,
      );
      const render = Effect.try({
        try: () =>
          observations.renderObservation({
            draft: observations.normalizeAppTree(
              buildObservedDraft({
                targetRef: nextRef,
                generation: nextEpoch,
                state,
                filtered,
                limit,
                shown,
                shownText,
                omitted,
                nextBounds,
                fallbackTitle,
              }),
            ),
            mode: query ? "query" : "full",
            ...(scope === undefined ? {} : { scope }),
            ...(!capture && args.mode === "diff" ? { resetReason: "desktop_reads_full" } : {}),
            limits: { treeBytes: observationReplyBudget(call, context.limits) },
          }),
        catch: renderFailure,
      });
      if (!capture) {
        const observation = yield* render;
        delete bound.needsSettleBeforeCapture;
        if (followedSheet && parentId !== undefined) {
          Object.assign(bound, {
            windowId: parentId,
            epoch: (epoch = nextEpoch),
            ref: nextRef,
            pointsStale: "restart" as const,
          });
          if (nextBounds === undefined) delete bound.windowBounds;
          else bound.windowBounds = nextBounds;
          bound.screenshots?.clear();
          delete bound.latestScreenshot;
        }
        bound.observationId = observation.observationId;
        const snapshotId = string(state.snapshot_id);
        if (snapshotId !== undefined) bound.snapshotId = snapshotId;
        // A read its budget cut keeps the rest for observe({after}) until the next read.
        if (observation.elements.length < shown.length)
          bound.pages = {
            base: observation.observationId,
            rows: shown,
            text: shownText,
            given: new Set(observation.elements.map((element) => element.index)),
            ids: new Set(),
          };
        else delete bound.pages;
        return { value: observation, category: "unverifiable" };
      }
      let observationId = kept;
      if (observationId === undefined) {
        observationId = (yield* render).observationId;
        bound.observationId = observationId;
      }
      const imagePart = reply.image;
      const width = integer(state.screenshot_width);
      const height = integer(state.screenshot_height);
      const bounds = object(state.window_bounds);
      const shotBounds = boundsOf(bounds);
      if (shotBounds !== undefined) bound.windowBounds = shotBounds;
      // Once shown wrong, the basis stays dropped until the next tree read, even if it matches again.
      if (shotBounds && bound.framesBasis && !sameRect(bound.framesBasis, shotBounds))
        delete bound.framesBasis;
      const captured = buildScreenshotCapture({
        callId: call.callId,
        targetId: bound.ref.id,
        observationId,
        state,
        imagePart,
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
      return { value: metadata, image, imageMetadata: metadata, category: "unverifiable" };
    },
  );
  const invoke = Effect.fn("DesktopTargetHost.invoke")(function* (
    call: ScreenHostCall,
    context: ScreenHostContext,
    inBatch = false,
  ): Effect.fn.Return<ScreenHostDispatchResult, ScreenRunError> {
    if (call.method === "launch_app" && !call.targetRef)
      return yield* launch(call, callArgs(call.args), context);
    const bound = resolve(call, context);
    if (!bound) return yield* Effect.fail(fail("stale_reference"));
    if (call.method === "select_text")
      return yield* selectText(bound, callArgs(call.args), call, context);
    const withInputEvidence = (
      tool: string,
      forwarded: Record<string, unknown>,
      acted: DesktopRow | undefined,
      runInput: Effect.Effect<ScreenHostDispatchResult, ScreenRunError>,
    ) =>
      Effect.suspend(() => {
        bound.needsSettleBeforeCapture = true;
        if (inBatch) return runInput;
        return runInputWithEvidence({
          send,
          call,
          context,
          pid: bound.pid,
          windowId: bound.windowId,
          connectionGeneration: bound.connectionGeneration,
          tracker: trackerFor(context, bound.connectionGeneration),
          tool,
          forwarded,
          acted,
          rows: bound.rows ?? [],
          runInput,
          onSettled: () => {
            delete bound.needsSettleBeforeCapture;
          },
        });
      });
    if (call.method === "invoke_menu") {
      const checkedMenu = validateMenuInput(callArgs(call.args), bound);
      if (checkedMenu.error || !checkedMenu.path)
        return yield* Effect.fail(checkedMenu.error ?? fail("invalid_argument"));
      const path = checkedMenu.path;
      bound.pointsStale ??= "input";
      if (!isMac) {
        bound.screenshots?.clear();
        delete bound.latestScreenshot;
      }
      return yield* withInputEvidence(
        "invoke_menu",
        { pid: bound.pid, window_id: bound.windowId, path },
        undefined,
        Effect.map(
          boundRequest(
            bound,
            "nothing",
            "invoke_menu",
            { pid: bound.pid, window_id: bound.windowId, path },
            call,
            context,
            { bound },
          ),
          (reply) => driverResult("invoke_menu", reply),
        ),
      );
    }
    if (call.method === "wait_for") {
      const args = callArgs(call.args);
      if (args.window === "hidden")
        return yield* pollHiddenWindow({
          list: () =>
            boundRequest(bound, "nothing", "list_windows", { pid: bound.pid }, call, context),
          pid: bound.pid,
          windowId: bound.windowId,
          timeoutMs: args.timeoutMs,
          cellDeadlineMillis: call.deadlineMillis,
        });
      const waited = buildWaitExpectation(args);
      if (waited.error || !waited.expectation)
        return yield* Effect.fail(waited.error ?? fail("invalid_argument"));
      const expectation = waited.expectation;
      const now = yield* Clock.currentTimeMillis;
      const requested = typeof args.timeoutMs === "number" ? args.timeoutMs : 10_000;
      const reply = yield* boundRequest(
        bound,
        "nothing",
        "verify_state",
        {
          pid: bound.pid,
          window_id: bound.windowId,
          expect: [expectation],
          // The driver call's own cap is this wait plus 2 s, within the cell's reserve.
          timeout_ms: Math.max(
            0,
            Math.min(requested, 10_000, call.deadlineMillis - now - CELL_RESERVE_MS - 2_000),
          ),
        },
        call,
        context,
      );
      const status = string(object(driverValue(reply))?.status) ?? "unknown";
      return {
        value: { met: status === "satisfied", status },
        category: status === "satisfied" ? "confirmed" : "unverifiable",
        evidence: [`verify_state:${status}`],
      };
    }
    if (call.method === "end_foreground") {
      const current = Option.getOrUndefined(
        yield* deps.leases.currentControl(context.invocation.thread.threadId),
      );
      const ok =
        current?.controlId === bound.controlId &&
        deps.leases.releaseForeground &&
        (yield* deps.leases.releaseForeground({
          threadId: context.invocation.thread.threadId,
          controlId: current.controlId,
        }));
      return ok
        ? { value: { released: true }, category: "confirmed" as const }
        : yield* Effect.fail(fail("unavailable"));
    }
    const args = callArgs(call.args);
    const prepared = prepareDesktopInput(call.method, args, bound, (el) => tokenOf(el, bound));
    if (prepared.error || !prepared.forwarded || !prepared.admission)
      return yield* Effect.fail(prepared.error ?? fail("invalid_argument"));
    const { forwarded, elementToken, actedRow, admission } = prepared;
    const tool = call.method === "right_click" ? "right_click" : call.method;
    const pointerResolved = applyDesktopPointerArgs(
      call.method,
      args,
      forwarded,
      pointerStateFor(bound, deps.platform, (el) => tokenOf(el, bound)),
    );
    if (!pointerResolved.ok) return yield* Effect.fail(pointerResolved.error);
    bound.pointsStale ??= "input";
    if (!isMac) {
      bound.screenshots?.clear();
      delete bound.latestScreenshot;
    }
    if (admission.clickedTableCell !== undefined)
      bound.lastClickedTableCell = admission.clickedTableCell;
    const needs = elementToken !== undefined ? "element" : pointerResolved.needs;
    return yield* withInputEvidence(
      tool,
      forwarded,
      actedRow,
      Effect.map(
        boundRequest(bound, needs, tool, forwarded, call, context, {
          bound,
          point:
            elementToken === undefined
              ? undefined
              : aimOf(bound.frames?.get(elementToken), bound.framesBasis),
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error.code === "stale_reference") delete bound.pages;
            }),
          ),
        ),
        (reply) => {
          const result = annotatePointerResult(
            driverResult(tool, reply),
            pointerResolved.windowPoint,
          );
          const replyData = object(driverValue(reply));
          const focusConfirmed = replyData?.focused === true || replyData?.focus_confirmed === true;
          if (admission.clearClickedTableCell && focusConfirmed) delete bound.lastClickedTableCell;
          return result;
        },
      ),
    );
  });
  const dispatch: DesktopTargetHost["dispatch"] = (call, context) =>
    call.method === "tab_status" || call.method === "read_page"
      ? Effect.fail(fail("unsupported"))
      : call.method === "list_menu_bar_extras"
        ? menuBarExtras(call, callArgs(call.args), context)
        : call.method === "bind_app"
          ? bindApp(call, context)
          : call.method === "list_apps" || call.method === "list_windows"
            ? discover(call, context)
            : ["get_window_state", "get_accessibility_tree", "verify_state", "screenshot"].includes(
                  call.method,
                )
              ? observe(call, context)
              : invoke(call, context);
  const dispatchBatch: NonNullable<ScreenHostDispatcher["dispatchBatch"]> = Effect.fn(
    "DesktopTargetHost.dispatchBatch",
  )(function* (calls, context, markDispatched) {
    const refused = preflightDesktopBatch(calls, (call) =>
      inspectBatchMember(
        call.method,
        callArgs(call.args),
        resolve(call, context),
        deps.platform,
        tokenOf,
      ),
    );
    if (refused !== undefined) return refused;
    const first = calls[0];
    const firstBound = first && resolve(first, context);
    if (first && firstBound)
      yield* seedBatchBaseline({
        send,
        calls,
        context,
        pid: firstBound.pid,
        connectionGeneration: firstBound.connectionGeneration,
        boundInCellId: firstBound.boundInCellId,
        boundWindows: firstBound.boundWindows,
        tracker: trackerFor(context, firstBound.connectionGeneration),
      });
    return yield* dispatchInTurn(
      calls,
      (each, index) =>
        Effect.suspend(() => {
          markDispatched(index);
          return INPUT_METHODS.has(each.method)
            ? invoke(each, context, true)
            : dispatch(each, context);
        }),
      BATCH_FAILED_CATEGORIES,
    );
  });
  return {
    discover,
    bindApp,
    observe,
    invoke,
    dispatchBatch,
    invalidateTarget: (targetId) => {
      observations.evictTarget(targetId);
      targets.delete(targetId);
    },
    matchesControl: (targetId, controlId, windowId) => {
      const target = targets.get(targetId);
      return (
        target?.controlId === controlId && (windowId === undefined || target.windowId === windowId)
      );
    },
    controlIdForTarget: (targetId) => targets.get(targetId)?.controlId,
    windowForTarget: (targetId) => {
      const target = targets.get(targetId);
      return target && { pid: target.pid, windowId: target.windowId };
    },
    setCursorGeneration: (lookup) => void (cursorGeneration = lookup),
    finishCell: (context, options) => {
      const key = cellKey(context);
      const entry = cellTrackers.get(key);
      cellTrackers.delete(key);
      return finishCellTracker(entry, context, options, send);
    },
    finishTurn: (runId, turnId) => {
      for (const [targetId, bound] of targets)
        if (bound.ref.runId === runId && bound.ref.turnId === turnId) {
          observations.evictTarget(targetId);
          targets.delete(targetId);
        }
    },
    availability: Effect.fn("DesktopTargetHost.availability")(function* (context) {
      const current = Option.getOrUndefined(
        yield* deps.leases.currentControl(context.invocation.thread.threadId),
      );
      if (!current)
        return [{ kind: "app" as const, available: false, reason: "no_lease" as const }];
      const state = yield* deps.leases
        .controlState(context.invocation.thread.threadId, current.controlId)
        .pipe(Effect.orElseSucceed(() => ({ _tag: "ended" as const })));
      return availabilityFromControlState(state);
    }),
    dispatch,
  };
};
