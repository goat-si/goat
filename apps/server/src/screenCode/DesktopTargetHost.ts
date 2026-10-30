// @effect-diagnostics preferSchemaOverJson:off - Driver replies are bounded by the primitive channel.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HostProcess from "@goat/shared/HostProcess";
import type {
  ComputerUseOverlayPoint,
  ScreenHostCall,
  ScreenRunError,
  ScreenTargetRef,
} from "@goat/contracts";
import { COMPUTER_USE_PRIMITIVE_ARGS_BYTES, EnvironmentId } from "@goat/contracts";
import { driverOutcomeSafety } from "../cua/ComputerUseDriverOutcome.ts";
import type { ComputerUsePrimitiveChannel } from "../cua/ComputerUsePrimitiveChannel.ts";
import type { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import type { ScreenCellRef, ScreenTargetLabel } from "../cua/ComputerUseCallApps.ts";
import type {
  ScreenHostContext,
  ScreenHostDispatcher,
  ScreenHostDispatchResult,
} from "./ScreenHostBridge.ts";
import { dispatchInTurn } from "./ScreenBatchGroups.ts";
import { CELL_RESERVE_MS } from "../cua/ComputerUseCallCaps.ts";
import { driverError, driverResult, driverValue, fail } from "./DesktopDriverReplies.ts";
import { ScreenObservations } from "./ScreenObservations.ts";
import { makeBindWindow, makeLaunch } from "./DesktopLaunch.ts";
import {
  BATCH_FAILED_CATEGORIES,
  preflightDesktopBatch,
  type GuardElement,
} from "./DesktopInputGuards.ts";
import { aimOf, type Placed, type Rect } from "./DesktopFrames.ts";
import { waitForOutcome } from "./DesktopWindowClosure.ts";
import { windowIntentOf } from "./DesktopWindowIntent.ts";
import {
  annotatePointerResult,
  applyDesktopPointerArgs,
  pointerStateFor,
  type ScreenshotBasis,
} from "./DesktopTargetPoints.ts";
import {
  finishCellTracker,
  pollHiddenWindow,
  runInputWithEvidence,
  seedBatchBaseline,
  withoutUnprovenClose,
} from "./DesktopEvidence.ts";
import {
  availabilityFromControlState,
  buildWaitExpectation,
  inspectBatchMember,
  INPUT_METHODS,
  prepareDesktopInput,
  validateMenuInput,
  withoutWindowWatch,
} from "./DesktopInputPlan.ts";
import {
  CellWindowTracker,
  type CellWindowsOutcome,
  listingProvesAbsent,
  matchBindWindow,
  parseWindowList,
  type SheetTrigger,
  type WindowEntry,
  withHolders,
} from "./DesktopWindows.ts";
import { noteHops } from "./DesktopHops.ts";
import { runDesktopObserve } from "./DesktopObserveLatency.ts";
import { type DesktopPages, type DesktopRow } from "./DesktopObserveRead.ts";
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
  diffBaseline?: boolean;
  fullObservationId?: string;
  lastReadCut?: boolean;
  /** Input went to the window, or a new driver replaced the one that took its latest screenshot. */
  pointsStale?: "input" | "restart";
  /** Input ran without a post-input 60 ms settle sleep; the next screenshot settles first. */
  needsSettleBeforeCapture?: boolean;
  /** When that input returned; the next capture waits only for the rest of the settle time. */
  inputDrivenAt?: number;
  /** Element frames from the tree behind observationId, by driver token. */
  frames?: ReadonlyMap<string, Placed>;
  /** Element roles, labels and table-cell ancestry from the tree behind observationId. */
  elementsByToken?: ReadonlyMap<string, GuardElement>;
  /** Set when the previous input on this window clicked a table cell. */
  lastClickedTableCell?: number | string;
  sheetTrigger?: SheetTrigger;
  sheetOriginWindowId?: number;
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
    const requestedAt = yield* Clock.currentTimeMillis;
    const reply = yield* deps.primitiveChannel.request({
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
    noteHops(call, reply, (yield* Clock.currentTimeMillis) - requestedAt);
    return reply;
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
    delete bound.diffBaseline;
    delete bound.fullObservationId;
    delete bound.lastReadCut;
    delete bound.pages;
    delete bound.elementsByToken;
    bound.screenshots?.clear();
    delete bound.latestScreenshot;
    bound.pointsStale = "restart";
    const { since: _since, ...freshArgs } = args;
    return yield* request(
      tool,
      tool === "get_window_state" ? freshArgs : args,
      call,
      context,
      bound.connectionGeneration,
      cursor,
    );
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
      return yield* withHolders(reply, call, context, deps.leases, request);
    },
  );
  const bindApp: DesktopTargetHost["bindApp"] = Effect.fn("DesktopTargetHost.bindApp")(
    function* (call, context) {
      const args = callArgs(call.args);
      const bundleId = string(args.bundle_id) ?? string(args.bundleId);
      const name = string(args.name);
      const appId = bundleId ?? name;
      const requestedWindow = integer(args.window_id) ?? integer(args.windowId);
      if (!requestedWindow)
        return yield* Effect.fail(
          fail(
            "invalid_argument",
            "Pass window_id from screen.discover(), with or without a name.",
          ),
        );
      const appsReply = yield* request("list_apps", {}, call, context);
      const listed = object(driverValue(appsReply))?.apps;
      const pids = new Set(
        array(listed)
          .map(object)
          .filter((app) => app !== undefined)
          .filter(
            (app) =>
              appId !== undefined && (bundleId ? app.bundle_id === bundleId : app.name === name),
          )
          .map((app) => integer(app.pid)),
      );
      pids.delete(undefined);
      // A name list_apps does not know may still be the app_name discover lists for the window.
      if (bundleId && Array.isArray(listed) && pids.size === 0)
        return yield* Effect.fail(fail("target_missing"));
      const listWindows = Effect.fn("DesktopTargetHost.bindListWindows")(function* (
        windowArgs: Record<string, unknown>,
      ) {
        const reply = yield* request(
          "list_windows",
          windowArgs,
          call,
          context,
          appsReply.connectionGeneration,
        );
        if (reply.connectionGeneration !== appsReply.connectionGeneration)
          return yield* Effect.fail(fail("stale_reference"));
        return { reply, windows: object(driverValue(reply))?.windows };
      });
      // One process: its own list, every layer (macOS lists only layer 0 without a pid); window
      // ids are unique on a host. Otherwise every window, so the found window shows its owner. A
      // cut app list narrows by the bundle filter, a name substring match on every platform, so
      // matchBindWindow then checks the window's own app_name.
      const [onlyPid] = Array.isArray(listed) && pids.size === 1 ? [...pids] : [];
      const filter =
        onlyPid !== undefined
          ? { pid: onlyPid }
          : bundleId && !Array.isArray(listed)
            ? { app: bundleId }
            : undefined;
      let { reply: windowsReply, windows: listedWindows } = yield* listWindows(filter ?? {});
      let listedPid = onlyPid;
      let bundleFiltered = isMac && filter !== undefined && "app" in filter;
      // A filtered list that may have left the window out keeps that doubt past the re-list.
      let absenceUnproven = false;
      // Not among the filtered windows: whose window it is, if anyone's, decides the answer.
      if (
        filter !== undefined &&
        Array.isArray(listedWindows) &&
        !listedWindows.some((window) => object(window)?.window_id === requestedWindow)
      ) {
        absenceUnproven = !listingProvesAbsent(driverValue(windowsReply), requestedWindow);
        ({ reply: windowsReply, windows: listedWindows } = yield* listWindows({}));
        listedPid = undefined;
        bundleFiltered = false;
      }
      // Every window passed the reply cap while the app runs as several processes: each one's
      // own list holds all of its windows, so they are read until one shows the window.
      if (!Array.isArray(listedWindows) && filter === undefined && pids.size > 1)
        for (const each of pids) {
          if (each === undefined) continue;
          const part = yield* listWindows({ pid: each });
          if (!Array.isArray(part.windows)) break;
          if (part.windows.some((window) => object(window)?.window_id === requestedWindow)) {
            ({ reply: windowsReply, windows: listedWindows } = part);
            listedPid = each;
            break;
          }
        }
      // A list cut at the reply cap cannot show the window, its owner, or a duplicate of its id.
      if (!Array.isArray(listedWindows))
        return yield* Effect.fail(
          fail(
            "downstream_failure",
            "The window list came back incomplete, so window " +
              requestedWindow +
              " could not be checked and nothing was bound. Try again.",
          ),
        );
      const unproven = fail(
        "downstream_failure",
        "The driver's window list says it may be incomplete, so window " +
          requestedWindow +
          " could not be checked and nothing was bound. Try again.",
      );
      const matched = matchBindWindow({
        listedApps: listed,
        listedWindows,
        bundleId,
        name,
        requestedWindow,
        bundleFiltered,
      });
      if (
        matched.error?.detail === "window_gone" &&
        (absenceUnproven || !listingProvesAbsent(driverValue(windowsReply), requestedWindow))
      )
        return yield* Effect.fail(unproven);
      // macOS lists windows above layer 0 (panels, popovers) only for their pid.
      if (matched.error?.detail === "window_gone" && isMac && filter === undefined)
        return yield* Effect.fail({
          ...matched.error,
          nextStep:
            "Window " +
            requestedWindow +
            " is not in the window list: it is closed, or a panel macOS lists only with its app. Pass the bundle_id or name of the app that owns it with window_id.",
        });
      if (matched.error || !matched.pid || !matched.window)
        return yield* Effect.fail(matched.error ?? fail("target_missing"));
      const { pid, app, window: foundWin } = matched;
      // The baseline later window checks compare with: the bound process's own complete list.
      const own = listedPid === pid ? undefined : yield* listWindows({ pid });
      const baseline = own === undefined ? listedWindows : own.windows;
      if (!Array.isArray(baseline))
        return yield* Effect.fail(
          fail(
            "downstream_failure",
            "The window list of pid " +
              pid +
              " came back incomplete, so nothing was bound. Try again.",
          ),
        );
      // The process's own list is read last, so it decides: the window must still be in it, once.
      const again = baseline.filter((window) => object(window)?.window_id === requestedWindow);
      if (
        again.length === 0 &&
        !listingProvesAbsent(driverValue(own?.reply ?? windowsReply), requestedWindow)
      )
        return yield* Effect.fail(unproven);
      if (again.length !== 1 || object(again[0])?.pid !== pid)
        return yield* Effect.fail(
          again.length > 1
            ? fail(
                "target_ambiguous",
                "The driver lists window " +
                  requestedWindow +
                  " more than once; call screen.discover() and bind again.",
              )
            : {
                ...fail(
                  "target_missing",
                  "That window is closed; pick one from screen.discover().",
                ),
                detail: "window_gone",
              },
        );
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
          appId:
            string(app?.bundle_id) ??
            string(app?.name) ??
            appId ??
            string(foundWin.app_name) ??
            String(pid),
          iconBundleId: bundleId ?? string(app?.bundle_id),
          bounds: foundWin.bounds,
          connectionGeneration: windowsReply.connectionGeneration,
          controlId: current.controlId,
        },
        context,
      );
      const created = targets.get(ref.id);
      if (created) {
        created.boundWindows = parseWindowList({ windows: baseline }, pid);
        created.boundInCellId = context.cellId;
      }
      return {
        value: ref,
        category: "confirmed",
        evidence: [`Window ${requestedWindow} of pid ${pid} is in the driver's window list`],
      };
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
  const observeDeps = {
    observations,
    targets,
    boundRequest,
    listWindows: (bound: BoundWindow, call: ScreenHostCall, context: ScreenHostContext) =>
      request("list_windows", { pid: bound.pid }, call, context),
    jpegScreenshots: isMac,
    epoch: () => epoch,
    setEpoch: (next: number) => void (epoch = next),
  };
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
      return yield* runDesktopObserve(observeDeps, bound, call, context, callArgs(call.args));
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
      verify: boolean,
    ) =>
      Effect.suspend(() => {
        bound.needsSettleBeforeCapture = true;
        delete bound.inputDrivenAt;
        const driven = (at: number) => void (bound.inputDrivenAt = at);
        // A batch member reads nothing around itself unless it asks to verify; one that opens or
        // closes a window goes through the single-call path, which keeps it unverifiable.
        if (inBatch && !verify && windowIntentOf(tool, forwarded, acted) === undefined)
          return runInput.pipe(
            Effect.tap(() => Effect.map(Clock.currentTimeMillis, driven)),
            Effect.map((result) => withoutUnprovenClose(tool, result)),
          );
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
          verify,
          seedWindows: bound.boundInCellId === context.cellId ? bound.boundWindows : undefined,
          opensWindow: bound.sheetTrigger !== undefined,
          onDriven: driven,
          onSettled: () => {
            delete bound.needsSettleBeforeCapture;
          },
        });
      });
    if (call.method === "invoke_menu") {
      const tracker = trackerFor(context, bound.connectionGeneration);
      const checkedMenu = validateMenuInput(callArgs(call.args), bound, tracker);
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
        callArgs(call.args).verify === true,
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
      return yield* waitForOutcome({
        status,
        gone: args.window === "gone",
        list: () =>
          boundRequest(bound, "nothing", "list_windows", { pid: bound.pid }, call, context),
        target: bound,
        cellDeadlineMillis: call.deadlineMillis,
      });
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
    const tracker = trackerFor(context, bound.connectionGeneration);
    const prepared = prepareDesktopInput(call.method, args, bound, tokenOf, tracker);
    if (prepared.error || !prepared.forwarded || !prepared.admission)
      return yield* Effect.fail(prepared.error ?? fail("invalid_argument"));
    const { elementToken, actedRow, admission } = prepared;
    const forwarded = isMac
      ? withoutWindowWatch(call.method, prepared.forwarded, args)
      : prepared.forwarded;
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
            tool,
          );
          const replyData = object(driverValue(reply));
          const focusConfirmed = replyData?.focused === true || replyData?.focus_confirmed === true;
          if (admission.clearClickedTableCell && focusConfirmed) delete bound.lastClickedTableCell;
          return result;
        },
      ),
      args.verify === true,
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
    if (first && firstBound) {
      const baseline = yield* seedBatchBaseline({
        send,
        calls,
        context,
        pid: firstBound.pid,
        connectionGeneration: firstBound.connectionGeneration,
        boundInCellId: firstBound.boundInCellId,
        boundWindows: firstBound.boundWindows,
        tracker: trackerFor(context, firstBound.connectionGeneration),
      }).pipe(Effect.result);
      if (baseline._tag === "Failure") return [Exit.fail(baseline.failure)];
    }
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
