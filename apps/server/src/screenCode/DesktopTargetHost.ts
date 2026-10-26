// @effect-diagnostics preferSchemaOverJson:off nodeBuiltinImport:off - Driver replies are bounded by the primitive channel; target IDs are opaque UUIDs.
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ComputerUsePrimitiveReply, ScreenHostCall, ScreenImage, ScreenImageMetadata, ScreenRunError, ScreenTargetRef } from "@goat/contracts";
import type { ComputerUsePrimitiveChannel } from "../cua/ComputerUsePrimitiveChannel.ts";
import type { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import type { ScreenHostContext, ScreenHostDispatcher, ScreenHostDispatchResult } from "./ScreenHostBridge.ts";
import { ScreenObservations } from "./ScreenObservations.ts";

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const array = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];
const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const fail = (code: ScreenRunError["code"], nextStep = "Observe the desktop and try again."): ScreenRunError => ({
  code, effectStarted: false, nextStep,
});
const driverValue = (reply: ComputerUsePrimitiveReply): unknown => {
  const result = object(reply.result);
  return result?.structuredContent ?? result;
};
const driverError = (reply: ComputerUsePrimitiveReply): ScreenRunError | undefined => {
  if (reply.status === "unknown_outcome") return { ...fail("unknown_outcome"), effectStarted: true };
  if (reply.status === "not_started") return fail("unavailable");
  const result = object(reply.result);
  if (object(result?.structuredContent)?.effect === "refused") return fail("permission_denied");
  if (result?.isError === true || reply.error !== undefined)
    return object(result?.structuredContent)?.effect === "unverifiable"
      ? { ...fail("unknown_outcome"), effectStarted: true }
      : fail("downstream_failure");
  return undefined;
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
}

export interface DesktopTargetHost extends ScreenHostDispatcher {
  readonly discover: (call: ScreenHostCall, context: ScreenHostContext) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
  readonly bindApp: (call: ScreenHostCall, context: ScreenHostContext) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
  readonly observe: (call: ScreenHostCall, context: ScreenHostContext) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
  readonly invoke: (call: ScreenHostCall, context: ScreenHostContext) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
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
    tool: string, args: Record<string, unknown>, call: ScreenHostCall, context: ScreenHostContext,
    expectedConnectionGeneration?: string,
  ) {
    if (!Schema.is(Schema.Json)(args)) return yield* Effect.fail(fail("invalid_argument"));
    const reply = yield* deps.primitiveChannel.request({
      threadId: context.invocation.thread.threadId,
      runId: context.runId, turnId: context.turnId, callId: call.callId,
      deadlineMillis: call.deadlineMillis, tool, args,
      ...(expectedConnectionGeneration === undefined ? {} : { expectedConnectionGeneration }),
    });
    const error = driverError(reply);
    if (error) {
      const readOnly = tool === "list_apps" || tool === "list_windows" || tool === "get_window_state";
      return yield* Effect.fail(error.code === "downstream_failure" && !readOnly
        ? { ...fail("unknown_outcome"), effectStarted: true } : error);
    }
    return reply;
  });
  const resolve = (call: ScreenHostCall, context: ScreenHostContext) => {
    const ref = call.targetRef;
    const bound = ref && targets.get(ref.id);
    return ref?.kind === "app" && bound &&
      ref.environmentId === context.environmentId && ref.runId === context.runId &&
      ref.turnId === context.turnId && ref.generation === bound.epoch
      ? bound : undefined;
  };
  const discover: DesktopTargetHost["discover"] = Effect.fn("DesktopTargetHost.discover")(
    function* (call, context) {
      if (call.method !== "list_apps" && call.method !== "list_windows")
        return yield* Effect.fail(fail("unsupported"));
      const args = object(call.args) ?? {};
      const reply = yield* request(call.method, call.method === "list_windows" && integer(args.pid)
        ? { pid: args.pid } : {}, call, context);
      return { value: driverValue(reply), category: "unverifiable" };
    },
  );
  const bindApp: DesktopTargetHost["bindApp"] = Effect.fn("DesktopTargetHost.bindApp")(
    function* (call, context) {
      const args = object(call.args) ?? {};
      const bundleId = string(args.bundle_id) ?? string(args.bundleId);
      const name = string(args.name);
      const appId = bundleId ?? name;
      const requestedWindow = integer(args.window_id) ?? integer(args.windowId);
      if (!appId || !requestedWindow) return yield* Effect.fail(fail("invalid_argument"));
      const appsReply = yield* request("list_apps", {}, call, context);
      const apps = array(object(driverValue(appsReply))?.apps).map(object).filter((app) => app !== undefined);
      const matches = apps.filter((app) => bundleId ? app.bundle_id === bundleId : app.name === name);
      if (matches.length !== 1) return yield* Effect.fail(fail("target_ambiguous"));
      const pid = integer(matches[0]?.pid);
      if (!pid) return yield* Effect.fail(fail("target_missing"));
      const windowsReply = yield* request("list_windows", { pid }, call, context, appsReply.connectionGeneration);
      if (windowsReply.connectionGeneration !== appsReply.connectionGeneration)
        return yield* Effect.fail(fail("stale_reference"));
      const windows = array(object(driverValue(windowsReply))?.windows).map(object).filter((window) => window !== undefined);
      const matchingWindows = windows.filter((window) => window.pid === pid && window.window_id === requestedWindow);
      if (matchingWindows.length !== 1) return yield* Effect.fail(fail("target_ambiguous"));
      const current = Option.getOrUndefined(yield* deps.leases.currentControl(context.invocation.thread.threadId));
      if (!current) return yield* Effect.fail(fail("unavailable"));
      for (const [id, previous] of targets)
        if (previous.pid === pid && previous.windowId === requestedWindow) {
          observations.index.invalidateTarget(id);
          targets.delete(id);
        }
      const ref: ScreenTargetRef = {
        id: randomUUID(), kind: "app", environmentId: context.environmentId,
        runId: context.runId, turnId: context.turnId, generation: ++epoch,
      };
      const bound: BoundWindow = { ref, pid, windowId: requestedWindow, appId: string(matches[0]?.bundle_id) ?? string(matches[0]?.name) ?? appId, epoch, connectionGeneration: windowsReply.connectionGeneration, controlId: current.controlId };
      targets.set(ref.id, bound);
      return { value: ref, category: "unverifiable" };
    },
  );
  const observe: DesktopTargetHost["observe"] = Effect.fn("DesktopTargetHost.observe")(
    function* (call, context) {
      const bound = resolve(call, context);
      if (!bound) return yield* Effect.fail(fail("stale_reference"));
      if (!["get_window_state", "get_accessibility_tree", "verify_state", "screenshot"].includes(call.method))
        return yield* Effect.fail(fail("unsupported"));
      const capture = call.method === "screenshot";
      const reply = yield* request("get_window_state", {
        pid: bound.pid, window_id: bound.windowId,
        include_accessibility_tree: !capture, include_screenshot: capture,
        max_elements: 4096,
      }, call, context, bound.connectionGeneration);
      const state = object(driverValue(reply));
      if (!state || state.pid !== bound.pid || state.window_id !== bound.windowId) {
        observations.index.invalidateTarget(bound.ref.id);
        targets.delete(bound.ref.id);
        return yield* Effect.fail(fail("stale_reference"));
      }
      const elements = array(state.elements).map(object).filter((entry) => entry !== undefined)
        .flatMap((entry) => {
          const token = string(entry.element_token);
          if (!token) return [];
          return [{
            role: string(entry.role) ?? "unknown",
            name: string(entry.label) ?? "",
            ...(typeof entry.value === "string" ? { text: entry.value } : {}),
            driverToken: token,
          }];
        });
      const observation = yield* Effect.try({ try: () => observations.renderObservation({
        draft: observations.normalizeAppTree({
          targetRef: bound.ref, targetGeneration: bound.epoch,
          surfaceGeneration: bound.epoch,
          indexedText: typeof state.tree_markdown === "string" ? state.tree_markdown : "",
          complete: state.elements_complete === true,
          truncated: state.truncated === true,
          loading: false, elements,
        }),
        mode: "full", limits: { treeBytes: context.limits.treeBytes },
      }), catch: (cause) => fail(cause instanceof Error && cause.message === "Screen observation metadata exceeds tree budget"
        ? "tree_limit" : "downstream_failure") });
      bound.observationId = observation.observationId;
      if (!capture) return { value: observation, category: "unverifiable" };
      const imagePart = reply.image;
      const width = integer(state.screenshot_width);
      const height = integer(state.screenshot_height);
      const bounds = object(state.window_bounds);
      if (!imagePart || !width || !height || imagePart.width !== width || imagePart.height !== height)
        return yield* Effect.fail(fail("downstream_failure"));
      const mimeType = imagePart.mimeType === "image/jpeg" ? "image/jpeg" as const : "image/png" as const;
      const metadata: ScreenImageMetadata = {
        imageRef: randomUUID(), callId: call.callId, targetId: bound.ref.id,
        observationId: observation.observationId, regionId: randomUUID(),
        region: {
          kind: "window", x: typeof bounds?.x === "number" ? bounds.x : 0,
          y: typeof bounds?.y === "number" ? bounds.y : 0,
          width: typeof bounds?.width === "number" && bounds.width > 0 ? bounds.width : width,
          height: typeof bounds?.height === "number" && bounds.height > 0 ? bounds.height : height,
        },
        pixelWidth: width, pixelHeight: height,
        scale: typeof state.screenshot_scale === "number" && state.screenshot_scale > 0
          ? state.screenshot_scale : 1,
        mimeType,
      };
      const image: ScreenImage = { ...metadata, bytes: imagePart.bytes };
      return { value: metadata, image, imageMetadata: metadata, category: "unverifiable" };
    },
  );
  const invoke: DesktopTargetHost["invoke"] = Effect.fn("DesktopTargetHost.invoke")(
    function* (call, context) {
      const bound = resolve(call, context);
      if (!bound) return yield* Effect.fail(fail("stale_reference"));
      if (call.method === "release_foreground") {
        const current = Option.getOrUndefined(yield* deps.leases.currentControl(context.invocation.thread.threadId));
        if (!current || current.controlId !== bound.controlId || !deps.leases.releaseForeground || !(yield* deps.leases.releaseForeground({
          threadId: context.invocation.thread.threadId, controlId: current.controlId,
        }))) return yield* Effect.fail(fail("unavailable"));
        return { value: { released: true }, category: "confirmed" as const };
      }
      const methods = new Set(["click", "right_click", "drag", "scroll", "type_text", "press_key", "set_value", "bring_to_front", "launch_app"]);
      if (!methods.has(call.method)) return yield* Effect.fail(fail("unsupported"));
      const args = object(call.args) ?? {};
      const element = object(args.elementRef);
      if (call.method === "set_value" && !element)
        return yield* Effect.fail(fail("invalid_argument"));
      let elementToken: string | undefined;
      if (element) {
        const ref = {
          id: string(element.id) ?? "", targetId: string(element.targetId) ?? "",
          observationId: string(element.observationId) ?? "",
          surfaceGeneration: element.surfaceGeneration,
        };
        if (ref.targetId !== bound.ref.id || ref.observationId !== bound.observationId ||
          ref.surfaceGeneration !== bound.epoch)
          return yield* Effect.fail(fail("stale_reference"));
        elementToken = observations.index.resolveElement(ref as Parameters<typeof observations.index.resolveElement>[0]);
        if (!elementToken) return yield* Effect.fail(fail("stale_reference"));
      }
      const target = { kind: "window", pid: bound.pid, window_id: bound.windowId };
      const forwarded: Record<string, unknown> = { ...args, target, delivery_mode: "background" };
      delete forwarded.elementRef;
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
      const reply = yield* request(tool, forwarded, call, context, bound.connectionGeneration);
      const value = driverValue(reply);
      const effect = object(value)?.effect;
      const category = effect === "confirmed" || effect === "partial" || effect === "unverifiable" || effect === "suspected_noop" || effect === "refused"
        ? effect : "unverifiable";
      const evidence = effect === "confirmed" ? ["driver:effect=confirmed"] : [];
      return { value, category, evidence };
    },
  );
  return {
    discover, bindApp, observe, invoke,
    invalidateTarget: (targetId) => {
      observations.index.invalidateTarget(targetId);
      targets.delete(targetId);
    },
    matchesControl: (targetId, controlId, windowId) => {
      const target = targets.get(targetId);
      return target?.controlId === controlId && (windowId === undefined || target.windowId === windowId);
    },
    controlIdForTarget: (targetId) => targets.get(targetId)?.controlId,
    finishTurn: (runId, turnId) => {
      for (const [targetId, bound] of targets)
        if (bound.ref.runId === runId && bound.ref.turnId === turnId) {
          observations.index.invalidateTarget(targetId);
          targets.delete(targetId);
        }
    },
    availability: Effect.fn("DesktopTargetHost.availability")(function* (context) {
      const current = Option.getOrUndefined(yield* deps.leases.currentControl(context.invocation.thread.threadId));
      if (!current) return [{ kind: "app" as const, available: false, reason: "no_lease" as const }];
      const state = yield* deps.leases.controlState(context.invocation.thread.threadId, current.controlId)
        .pipe(Effect.orElseSucceed(() => ({ _tag: "ended" as const })));
      if (state._tag === "active" && state.idle !== true)
        return [{ kind: "app" as const, available: true }];
      const reason = state._tag === "paused"
        ? state.reason === "private" ? "private" as const : "paused" as const
        : "no_lease" as const;
      return [{ kind: "app" as const, available: false, reason }];
    }),
    dispatch: (call, context) => call.method === "bind_app" ? bindApp(call, context)
      : call.method === "list_apps" || call.method === "list_windows" ? discover(call, context)
      : ["get_window_state", "get_accessibility_tree", "verify_state", "screenshot"].includes(call.method)
        ? observe(call, context) : invoke(call, context),
  };
};
