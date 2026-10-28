// @effect-diagnostics preferSchemaOverJson:off nodeBuiltinImport:off - Driver replies are bounded by the primitive channel; target IDs are opaque UUIDs.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  ComputerUsePrimitiveReply,
  ScreenHostCall,
  ScreenImage,
  ScreenImageMetadata,
  ScreenRunError,
  ScreenTargetRef,
} from "@goat/contracts";
import { ComputerUseRefusalDetail, ComputerUseRefusalReason } from "@goat/contracts";
import { driverOutcomeSafety } from "../cua/ComputerUseDriverOutcome.ts";
import type { ComputerUsePrimitiveChannel } from "../cua/ComputerUsePrimitiveChannel.ts";
import type { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import type {
  ScreenHostContext,
  ScreenHostDispatcher,
  ScreenHostDispatchResult,
} from "./ScreenHostBridge.ts";
import { observationReplyBudget } from "./ScreenHostBridge.ts";
import { ScreenObservations, type ScreenElementDetail } from "./ScreenObservations.ts";

const isJson = Schema.is(Schema.Json);
const isRefusalReason = Schema.is(ComputerUseRefusalReason);
const isRefusalDetail = Schema.is(ComputerUseRefusalDetail);

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
// The guest names its target in every call; the driver refuses arguments it does not know.
const callArgs = (args: ScreenHostCall["args"]): Record<string, unknown> => {
  const { targetRef: _targetRef, ...rest } = object(Array.isArray(args) ? args[0] : args) ?? {};
  return rest;
};
const array = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const natural = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
/** The driver's state and geometry for one element, in the observation's own names. */
const elementDetail = (entry: Record<string, unknown>): ScreenElementDetail => {
  const frame = object(entry.frame);
  const actions = array(entry.actions).filter(
    (action): action is string => typeof action === "string",
  );
  const parent = natural(entry.parent_index);
  return {
    ...(actions.length > 0 ? { actions } : {}),
    ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
    ...(typeof entry.selected === "boolean" ? { selected: entry.selected } : {}),
    ...(frame && finite(frame.x) && finite(frame.y) && finite(frame.w) && finite(frame.h)
      ? { frame: { x: frame.x, y: frame.y, width: frame.w, height: frame.h } }
      : {}),
    ...(finite(entry.min) && finite(entry.max)
      ? { range: { min: entry.min, max: entry.max } }
      : {}),
    ...(parent === undefined ? {} : { parent }),
  };
};
const fail = (
  code: ScreenRunError["code"],
  nextStep = "Observe the desktop and try again.",
): ScreenRunError => ({
  code,
  effectStarted: false,
  nextStep,
});
const driverValue = (reply: ComputerUsePrimitiveReply): unknown => {
  const result = object(reply.result);
  return result?.structuredContent ?? result;
};
const refusalOf = (structured: Record<string, unknown> | undefined) => {
  const app = string(structured?.app);
  const holder = string(structured?.holderThreadId);
  return {
    ...(isRefusalReason(structured?.refused) ? { refused: structured.refused } : {}),
    ...(isRefusalDetail(structured?.detail) ? { detail: structured.detail } : {}),
    ...(app !== undefined && app.length <= 200 ? { app } : {}),
    ...(holder !== undefined && holder.length <= 200 ? { holderThreadId: holder } : {}),
  };
};
/** What the refusal told the agent: why the call did not run and what to do instead. */
const refusalText = (
  result: Record<string, unknown> | undefined,
  structured: Record<string, unknown> | undefined,
): string | undefined => {
  const said =
    string(object(structured?.refusal)?.message) ??
    string(structured?.message) ??
    array(result?.content)
      .map(object)
      .map((part) => (part?.type === "text" ? string(part.text) : undefined))
      .find((text) => text !== undefined);
  return said === undefined || said.length <= 1000 ? said : `${said.slice(0, 999)}…`;
};
const driverError = (reply: ComputerUsePrimitiveReply): ScreenRunError | undefined => {
  if (reply.status === "unknown_outcome")
    return { ...fail("unknown_outcome"), effectStarted: true };
  const result = object(reply.result);
  const structured = object(result?.structuredContent);
  const said = refusalText(result, structured);
  // GOAT refused before the driver: keep its reason so the receipt says why.
  if (reply.status === "not_started")
    return { ...fail("unavailable", said), ...refusalOf(structured) };
  // The lease proxy's rule: the driver's own refusal; an explicit other effect wins over a status.
  if (
    structured !== undefined &&
    (structured.effect === undefined
      ? structured.status === "refused"
      : structured.effect === "refused")
  ) {
    const code = string(object(structured.refusal)?.code) ?? string(structured.code);
    return {
      ...fail(code === "invalid_arguments" ? "invalid_argument" : "permission_denied", said),
      ...refusalOf(structured),
    };
  }
  if (result?.isError === true || reply.error !== undefined)
    return structured?.effect === "unverifiable"
      ? { ...fail("unknown_outcome"), effectStarted: true }
      : fail("downstream_failure");
  return undefined;
};

/** An input tool's answer as a receipt category, read the way computer use reads it. */
const driverResult = (tool: string, reply: ComputerUsePrimitiveReply): ScreenHostDispatchResult => {
  const value = driverValue(reply);
  const effect = object(value)?.effect;
  const category =
    effect === "confirmed" || effect === "partial" || effect === "refused"
      ? effect
      : effect === "suspected_noop" || effect === "no_drop" || effect === "not_applied"
        ? "suspected_noop"
        : "unverifiable";
  return {
    value,
    category,
    evidence: effect === "confirmed" ? ["driver:effect=confirmed"] : [],
    safety: driverOutcomeSafety(tool, reply),
  };
};

interface BoundWindow {
  readonly ref: ScreenTargetRef;
  readonly pid: number;
  readonly windowId: number;
  readonly appId: string;
  readonly controlId: string;
  readonly epoch: number;
  readonly connectionGeneration: string;
  observationId?: string;
  /** The driver snapshot behind observationId; a screenshot that keeps it keeps the tree's refs. */
  snapshotId?: string;
  /** Input went to the window after its latest screenshot, so its pixels may no longer match. */
  pointsStale?: boolean;
}

export interface DesktopTargetHost extends ScreenHostDispatcher {
  readonly discover: (
    call: ScreenHostCall,
    context: ScreenHostContext,
  ) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
  readonly bindApp: (
    call: ScreenHostCall,
    context: ScreenHostContext,
  ) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
  readonly observe: (
    call: ScreenHostCall,
    context: ScreenHostContext,
  ) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
  readonly invoke: (
    call: ScreenHostCall,
    context: ScreenHostContext,
  ) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
  readonly invalidateTarget: (targetId: string) => void;
  readonly matchesControl: (targetId: string, controlId: string, windowId?: number) => boolean;
  readonly controlIdForTarget: (targetId: string) => string | undefined;
  readonly finishTurn: (runId: string, turnId: string) => void;
}

export const createDesktopTargetHost = (deps: {
  readonly primitiveChannel: ComputerUsePrimitiveChannel["Service"];
  readonly leases: ComputerUseLeases["Service"];
  readonly observations?: ScreenObservations;
}): DesktopTargetHost => {
  const observations = deps.observations ?? new ScreenObservations();
  const targets = new Map<string, BoundWindow>();
  let epoch = 0;
  const request = Effect.fn("DesktopTargetHost.request")(function* (
    tool: string,
    args: Record<string, unknown>,
    call: ScreenHostCall,
    context: ScreenHostContext,
    expectedConnectionGeneration?: string,
  ) {
    if (!isJson(args)) return yield* Effect.fail(fail("invalid_argument"));
    const reply = yield* deps.primitiveChannel.request({
      threadId: context.invocation.thread.threadId,
      runId: context.runId,
      turnId: context.turnId,
      callId: call.callId,
      deadlineMillis: call.deadlineMillis,
      tool,
      args,
      ...(expectedConnectionGeneration === undefined ? {} : { expectedConnectionGeneration }),
    });
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
      const named = array(object(driverValue(windowsReply))?.windows)
        .map(object)
        .filter((window) => window !== undefined)
        .filter(
          (window) =>
            window.window_id === requestedWindow &&
            (Array.isArray(listed)
              ? pids.has(integer(window.pid))
              : bundleId !== undefined ||
                window.app_name === undefined ||
                window.app_name === name),
        );
      const pid = integer(named[0]?.pid);
      if (!Array.isArray(listed) && !pid) return yield* Effect.fail(fail("target_missing"));
      if (named.length !== 1 || !pid) return yield* Effect.fail(fail("target_ambiguous"));
      const app = matches.find((candidate) => candidate.pid === pid);
      const current = Option.getOrUndefined(
        yield* deps.leases.currentControl(context.invocation.thread.threadId),
      );
      if (!current) return yield* Effect.fail(fail("unavailable"));
      for (const [id, previous] of targets)
        if (
          previous.pid === pid &&
          previous.windowId === requestedWindow &&
          previous.ref.runId === context.runId &&
          previous.ref.turnId === context.turnId
        ) {
          observations.evictTarget(id);
          targets.delete(id);
        }
      const ref: ScreenTargetRef = {
        id: NodeCrypto.randomUUID(),
        kind: "app",
        environmentId: context.environmentId,
        runId: context.runId,
        turnId: context.turnId,
        generation: ++epoch,
      };
      const bound: BoundWindow = {
        ref,
        pid,
        windowId: requestedWindow,
        appId: string(app?.bundle_id) ?? string(app?.name) ?? appId,
        epoch,
        connectionGeneration: windowsReply.connectionGeneration,
        controlId: current.controlId,
      };
      targets.set(ref.id, bound);
      return { value: ref, category: "unverifiable" };
    },
  );
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
      // A driver diff (`since`) keeps only changed rows and retires the others' tokens, and
      // goat.7 fails its own count check on it, so every desktop read is full: all refs stay usable.
      const reply = yield* request(
        "get_window_state",
        {
          pid: bound.pid,
          window_id: bound.windowId,
          include_accessibility_tree: !capture,
          include_screenshot: capture,
          max_elements: 4096,
          ...(capture ? {} : { tree_format: "both" }),
        },
        call,
        context,
        bound.connectionGeneration,
      );
      const state = object(driverValue(reply));
      if (!state || state.pid !== bound.pid || state.window_id !== bound.windowId) {
        observations.evictTarget(bound.ref.id);
        targets.delete(bound.ref.id);
        return yield* Effect.fail(fail("stale_reference"));
      }
      const elements = array(state.elements)
        .map(object)
        .filter((entry) => entry !== undefined)
        .flatMap((entry) => {
          const token = string(entry.element_token);
          if (!token) return [];
          const index = natural(entry.element_index);
          return [
            {
              role: string(entry.role) ?? "unknown",
              name: string(entry.label) ?? "",
              ...(typeof entry.value === "string" ? { text: entry.value } : {}),
              ...(index === undefined ? {} : { index }),
              ...elementDetail(entry),
              driverToken: token,
            },
          ];
        });
      const resetReason = capture
        ? undefined
        : args.mode === "diff"
          ? "desktop_reads_full"
          : args.mode === "query"
            ? "desktop_query_unsupported"
            : undefined;
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
      if (kept === undefined) {
        observations.evictTarget(bound.ref.id);
        delete bound.observationId;
        delete bound.snapshotId;
      }
      const render = Effect.try({
        try: () =>
          observations.renderObservation({
            draft: observations.normalizeAppTree({
              targetRef: bound.ref,
              targetGeneration: bound.epoch,
              surfaceGeneration: bound.epoch,
              indexedText: typeof state.tree_markdown === "string" ? state.tree_markdown : "",
              complete: state.elements_complete === true,
              truncated: state.truncated === true,
              loading: false,
              elements,
            }),
            mode: "full",
            ...(resetReason === undefined ? {} : { resetReason }),
            limits: { treeBytes: observationReplyBudget(call, context.limits) },
          }),
        catch: (cause) =>
          fail(
            cause instanceof Error &&
              cause.message === "Screen observation metadata exceeds tree budget"
              ? "tree_limit"
              : "downstream_failure",
          ),
      });
      if (!capture) {
        const observation = yield* render;
        bound.observationId = observation.observationId;
        const snapshotId = string(state.snapshot_id);
        if (snapshotId !== undefined) bound.snapshotId = snapshotId;
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
      if (
        !imagePart ||
        !width ||
        !height ||
        imagePart.width !== width ||
        imagePart.height !== height
      )
        return yield* Effect.fail(fail("downstream_failure"));
      const mimeType =
        imagePart.mimeType === "image/jpeg" ? ("image/jpeg" as const) : ("image/png" as const);
      const metadata: ScreenImageMetadata = {
        imageRef: NodeCrypto.randomUUID(),
        callId: call.callId,
        targetId: bound.ref.id,
        observationId,
        regionId: NodeCrypto.randomUUID(),
        region: {
          kind: "window",
          x: typeof bounds?.x === "number" ? bounds.x : 0,
          y: typeof bounds?.y === "number" ? bounds.y : 0,
          width: typeof bounds?.width === "number" && bounds.width > 0 ? bounds.width : width,
          height: typeof bounds?.height === "number" && bounds.height > 0 ? bounds.height : height,
        },
        pixelWidth: width,
        pixelHeight: height,
        scale:
          typeof state.screenshot_scale === "number" && state.screenshot_scale > 0
            ? state.screenshot_scale
            : 1,
        mimeType,
      };
      observations.index.putRegion(bound.ref.id, observationId, metadata.regionId, {
        ...metadata.region,
        pixelWidth: width,
        pixelHeight: height,
        scale: metadata.scale,
      });
      bound.pointsStale = false;
      const image: ScreenImage = { ...metadata, bytes: imagePart.bytes };
      return { value: metadata, image, imageMetadata: metadata, category: "unverifiable" };
    },
  );
  const invoke: DesktopTargetHost["invoke"] = Effect.fn("DesktopTargetHost.invoke")(
    function* (call, context) {
      if (call.method === "select_text")
        return yield* Effect.fail(
          fail(
            "unsupported",
            "Desktop select_text is unsupported by this runtime; nothing was sent. To replace an editable field's whole value, use setValue({ elementRef, value }).",
          ),
        );
      if (call.method === "launch_app" && !call.targetRef) {
        const args = callArgs(call.args);
        const bundleId = string(args.bundle_id) ?? string(args.bundleId);
        if (!bundleId) return yield* Effect.fail(fail("invalid_argument"));
        const current = Option.getOrUndefined(
          yield* deps.leases.currentControl(context.invocation.thread.threadId),
        );
        if (!current) return yield* Effect.fail(fail("unavailable"));
        const reply = yield* request("launch_app", { bundle_id: bundleId }, call, context);
        return driverResult("launch_app", reply);
      }
      const bound = resolve(call, context);
      if (!bound) return yield* Effect.fail(fail("stale_reference"));
      if (call.method === "invoke_menu") {
        const path = array(callArgs(call.args).path);
        if (
          path.length === 0 ||
          path.length > 16 ||
          !path.every((label) => typeof label === "string" && label.trim().length > 0)
        )
          return yield* Effect.fail(
            fail("invalid_argument", "Name the menu path, such as ['File', 'Open…']."),
          );
        bound.pointsStale = true;
        const reply = yield* request(
          "invoke_menu",
          { pid: bound.pid, window_id: bound.windowId, path },
          call,
          context,
          bound.connectionGeneration,
        );
        return driverResult("invoke_menu", reply);
      }
      if (call.method === "wait_for") {
        const args = callArgs(call.args);
        const window = args.window === "exists" || args.window === "gone" ? args.window : undefined;
        const role = string(args.role);
        const name = string(args.name);
        const value = typeof args.value === "string" ? args.value : undefined;
        if (window === undefined && role === undefined && name === undefined)
          return yield* Effect.fail(
            fail(
              "invalid_argument",
              "Wait for {role, name, value?, enabled?, selected?} or {window}.",
            ),
          );
        const expectation =
          window === undefined
            ? {
                element: {
                  selector: {
                    ...(role === undefined ? {} : { role }),
                    ...(name === undefined ? {} : { label_contains: name }),
                  },
                  exists: true,
                  ...(value === undefined ? {} : { value_equals: value }),
                  ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
                  ...(typeof args.selected === "boolean" ? { selected: args.selected } : {}),
                },
              }
            : { window: { exists: window === "exists" } };
        const now = yield* Clock.currentTimeMillis;
        const requested = typeof args.timeoutMs === "number" ? args.timeoutMs : 10_000;
        const reply = yield* request(
          "verify_state",
          {
            pid: bound.pid,
            window_id: bound.windowId,
            expect: [expectation],
            timeout_ms: Math.max(0, Math.min(requested, 10_000, call.deadlineMillis - now - 250)),
          },
          call,
          context,
          bound.connectionGeneration,
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
        if (
          !current ||
          current.controlId !== bound.controlId ||
          !deps.leases.releaseForeground ||
          !(yield* deps.leases.releaseForeground({
            threadId: context.invocation.thread.threadId,
            controlId: current.controlId,
          }))
        )
          return yield* Effect.fail(fail("unavailable"));
        return { value: { released: true }, category: "confirmed" as const };
      }
      const methods = new Set([
        "click",
        "right_click",
        "drag",
        "scroll",
        "type_text",
        "press_key",
        "set_value",
        "bring_to_front",
        "launch_app",
      ]);
      if (!methods.has(call.method)) return yield* Effect.fail(fail("unsupported"));
      const args = callArgs(call.args);
      const element = object(args.elementRef);
      if (call.method === "set_value" && !element)
        return yield* Effect.fail(fail("invalid_argument"));
      let elementToken: string | undefined;
      if (element) {
        const ref = {
          id: string(element.id) ?? "",
          targetId: string(element.targetId) ?? "",
          observationId: string(element.observationId) ?? "",
          surfaceGeneration: element.surfaceGeneration,
        };
        if (
          ref.targetId !== bound.ref.id ||
          ref.observationId !== bound.observationId ||
          ref.surfaceGeneration !== bound.epoch
        )
          return yield* Effect.fail(fail("stale_reference"));
        elementToken = observations.index.resolveElement(
          ref as Parameters<typeof observations.index.resolveElement>[0],
        );
        if (!elementToken) return yield* Effect.fail(fail("stale_reference"));
      }
      const target = { kind: "window", pid: bound.pid, window_id: bound.windowId };
      const forwarded: Record<string, unknown> = { ...args, target, delivery_mode: "background" };
      delete forwarded.elementRef;
      // The guest names its target in the call; the driver gets the window below instead.
      delete forwarded.targetRef;
      delete forwarded.element_token;
      delete forwarded.pid;
      delete forwarded.window_id;
      if (elementToken) forwarded.element_token = elementToken;
      if (call.method === "bring_to_front") {
        delete forwarded.delivery_mode;
        forwarded.pid = bound.pid;
        forwarded.window_id = bound.windowId;
      }
      if (call.method === "launch_app") {
        delete forwarded.delivery_mode;
        delete forwarded.target;
        forwarded.bundle_id = bound.appId;
      }
      const tool = call.method === "right_click" ? "right_click" : call.method;
      const aimed = ["x", "y", "from_x", "from_y", "to_x", "to_y"].some((key) => key in args);
      if (aimed && bound.pointsStale)
        return yield* Effect.fail(
          fail(
            "stale_reference",
            "Input reached this window after its latest screenshot; take a new screenshot before using points.",
          ),
        );
      // Any input, even one that fails, may change what is under a pixel.
      bound.pointsStale = true;
      const reply = yield* request(tool, forwarded, call, context, bound.connectionGeneration);
      return driverResult(tool, reply);
    },
  );
  return {
    discover,
    bindApp,
    observe,
    invoke,
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
      if (state._tag === "active" && state.idle !== true)
        return [{ kind: "app" as const, available: true }];
      const reason =
        state._tag === "paused"
          ? state.reason === "private"
            ? ("private" as const)
            : ("paused" as const)
          : ("no_lease" as const);
      return [{ kind: "app" as const, available: false, reason }];
    }),
    dispatch: (call, context) =>
      call.method === "tab_status" || call.method === "read_page"
        ? Effect.fail(fail("unsupported"))
        : call.method === "bind_app"
          ? bindApp(call, context)
          : call.method === "list_apps" || call.method === "list_windows"
            ? discover(call, context)
            : ["get_window_state", "get_accessibility_tree", "verify_state", "screenshot"].includes(
                  call.method,
                )
              ? observe(call, context)
              : invoke(call, context),
  };
};
