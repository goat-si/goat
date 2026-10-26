import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import type { ComputerUsePrimitiveReply, ScreenElementRef, ScreenHostCall, ScreenTargetRef, ThreadId } from "@goat/contracts";
import type { ComputerUsePrimitiveChannel } from "../cua/ComputerUsePrimitiveChannel.ts";
import type { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import type { ScreenHostContext } from "./ScreenHostBridge.ts";
import { screenRunLimits } from "./ScreenRunLimits.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const context = {
  runId: "r", turnId: "t", cellId: "c", threadId: "thread", environmentId: "env",
  limits: screenRunLimits(),
  invocation: { thread: { threadId: "thread" as ThreadId } },
} as ScreenHostContext;
const call = (method: ScreenHostCall["method"], args: ScreenHostCall["args"] = {}, targetRef?: ScreenTargetRef): ScreenHostCall => ({
  t: "call", runId: "r", turnId: "t", cellId: "c", callId: 1,
  method, args, deadlineMillis: 1000, ...(targetRef ? { targetRef } : {}),
});
const apps = { apps: [{ pid: 42, name: "Editor", bundle_id: "org.example.Editor" }] };
const windows = { windows: [{ pid: 42, window_id: 7, title: "Document" }] };
const state = { pid: 42, window_id: 7, tree_markdown: "Apply", elements_complete: true,
  elements: [{ role: "button", label: "Apply", element_token: "snapshot:1" }] };

const fixture = (override: Partial<Record<string, unknown>> = {}, connection = { id: "driver:1" }) => {
  const sent: Array<{ tool: string; args: unknown; expectedConnectionGeneration?: string }> = [];
  const channel = {
    request: (request: { tool: string; args: unknown; expectedConnectionGeneration?: string }) =>
      request.expectedConnectionGeneration !== undefined && request.expectedConnectionGeneration !== connection.id
        ? Effect.fail({ code: "stale_reference" as const, effectStarted: false, nextStep: "Bind again." })
        : Effect.sync(() => {
      sent.push({ tool: request.tool, args: request.args,
        ...(request.expectedConnectionGeneration === undefined ? {} : { expectedConnectionGeneration: request.expectedConnectionGeneration }) });
      const value = override[request.tool] ?? (
        request.tool === "list_apps" ? apps : request.tool === "list_windows" ? windows
          : request.tool === "get_window_state" ? state : { effect: "confirmed", evidence: ["driver:acted"] }
      );
      return { status: "settled", connectionGeneration: connection.id, result: { structuredContent: value },
        ...(request.tool === "get_window_state" && typeof (value as { image?: unknown }).image === "object"
          ? { image: (value as { image: unknown }).image } : {}) } as unknown as ComputerUsePrimitiveReply;
    }),
  } as unknown as ComputerUsePrimitiveChannel["Service"];
  const leases = {
    currentControl: () => Effect.succeed(Option.some({ controlId: "control" })),
    controlState: () => Effect.succeed({ _tag: "active", idle: false }),
    releaseForeground: () => Effect.succeed(true),
  } as unknown as ComputerUseLeases["Service"];
  return { host: createDesktopTargetHost({ primitiveChannel: channel, leases }), sent };
};

it.effect("a desktop ref bound before a driver restart is refused before input after the restart", () =>
  Effect.gen(function* () {
    const connection = { id: "driver:1" };
    const { host, sent } = fixture({}, connection);
    const bound = yield* host.bindApp(call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }), context);
    connection.id = "driver:2";
    const result = yield* host.invoke(call("click", { x: 1, y: 2 }, bound.value as ScreenTargetRef), context)
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe("stale_reference");
      expect(result.failure.effectStarted).toBe(false);
    }
    expect(sent.map((entry) => entry.tool)).toEqual(["list_apps", "list_windows"]);
  }),
);

it.effect("a desktop capture larger than the JSON cap reaches the host as a bounded image", () =>
  Effect.gen(function* () {
    const bytes = Buffer.alloc(80 * 1024, 1).toString("base64");
    const { host } = fixture({ get_window_state: {
      ...state, screenshot_width: 100, screenshot_height: 100,
      image: { mimeType: "image/png", bytes, width: 100, height: 100 },
    } });
    const bound = yield* host.bindApp(call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }), context);
    const capture = yield* host.observe(call("screenshot", {}, bound.value as ScreenTargetRef), context);
    expect(capture.image?.bytes).toBe(bytes);
    expect(capture.imageMetadata?.pixelWidth).toBe(100);
  }),
);

it.effect("ambiguous app/window binding refuses input", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({ list_apps: { apps: [apps.apps[0], apps.apps[0]] } });
    const result = yield* host.bindApp(call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }), context).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("target_ambiguous");
    expect(sent.map((entry) => entry.tool)).toEqual(["list_apps"]);
    const windowFixture = fixture({ list_windows: { windows: [windows.windows[0], windows.windows[0]] } });
    const ambiguousWindow = yield* windowFixture.host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }), context,
    ).pipe(Effect.result);
    expect(ambiguousWindow._tag).toBe("Failure");
    if (ambiguousWindow._tag === "Failure") expect(ambiguousWindow.failure.code).toBe("target_ambiguous");
    expect(windowFixture.sent.map((entry) => entry.tool)).toEqual(["list_apps", "list_windows"]);
  }),
);

it.effect("ScreenObservations alone mints desktop refs and stale element refs refuse before driver send", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture();
    const bound = yield* host.bindApp(call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }), context);
    const ref = bound.value as ScreenTargetRef;
    const observed = yield* host.observe(call("get_window_state", {}, ref), context);
    const observation = observed.value as { observationId: string; elements: Array<{ ref: unknown }> };
    expect(observation.elements[0]?.ref).toBeDefined();
    const stale = yield* host.invoke(call("click", { elementRef: { ...(observation.elements[0]?.ref as object), observationId: "old" } }, ref), context).pipe(Effect.result);
    expect(stale._tag).toBe("Failure");
    if (stale._tag === "Failure") expect(stale.failure.code).toBe("stale_reference");
    expect(sent.map((entry) => entry.tool)).toEqual(["list_apps", "list_windows", "get_window_state"]);
  }),
);

it.effect("desktop actions map only to allowed driver primitives", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture();
    const bound = yield* host.bindApp(call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }), context);
    const ref = bound.value as ScreenTargetRef;
    const observed = yield* host.observe(call("get_window_state", {}, ref), context);
    const elementRef = (observed.value as { elements: Array<{ ref: ScreenElementRef }> }).elements[0]?.ref;
    if (!elementRef) throw new Error("The observed button must have a ref");
    yield* host.invoke(call("click", { x: 10, y: 20 }, ref), context);
    yield* host.invoke(call("right_click", { x: 10, y: 20 }, ref), context);
    yield* host.invoke(call("drag", { from_x: 1, from_y: 2, to_x: 3, to_y: 4 }, ref), context);
    yield* host.invoke(call("scroll", { x: 10, y: 20, direction: "down" }, ref), context);
    yield* host.invoke(call("type_text", { text: "hello" }, ref), context);
    yield* host.invoke(call("press_key", { key: "Return" }, ref), context);
    yield* host.invoke(call("set_value", { value: "hello", elementRef }, ref), context);
    yield* host.invoke(call("bring_to_front", {}, ref), context);
    yield* host.invoke(call("launch_app", {}, ref), context);
    const released = yield* host.invoke(call("end_foreground", {}, ref), context);
    expect(released.value).toEqual({ released: true });
    expect(sent.map((entry) => entry.tool)).toEqual([
      "list_apps", "list_windows", "get_window_state", "click", "right_click", "drag", "scroll",
      "type_text", "press_key", "set_value", "bring_to_front", "launch_app",
    ]);
    expect(sent[3]?.args).toMatchObject({ target: { kind: "window", pid: 42, window_id: 7 }, x: 10, y: 20 });
  }),
);

it.effect("desktop discovery reports desktop_not_ready before a driver is bound", () =>
  Effect.gen(function* () {
    const { host } = fixture();
    const channel = { request: () => Effect.fail({ code: "unavailable", reason: "desktop_not_ready", effectStarted: false, nextStep: "Wait for desktop control." }) } as unknown as ComputerUsePrimitiveChannel["Service"];
    const unavailableHost = createDesktopTargetHost({
      primitiveChannel: channel,
      leases: { currentControl: () => Effect.succeed(Option.none()) } as unknown as ComputerUseLeases["Service"],
    });
    const result = yield* unavailableHost.discover(call("list_apps"), context).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("desktop_not_ready");
    expect((yield* host.availability(context))[0]?.available).toBe(true);
  }),
);

it.live("one cell invokes two desktop primitives in order through the admitted channel", () => {
  const { host, sent } = fixture();
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r", turnId: "t", threadId: "thread", environmentId: "env",
      invocation: context.invocation,
      source: "const apps = await screen.list_apps({}); const windows = await screen.list_windows({}); return [apps.apps.length, windows.windows.length];",
    });
    expect(result.value).toEqual([1, 1]);
    expect(sent.map((entry) => entry.tool)).toEqual(["list_apps", "list_windows"]);
    yield* service.finishTurn({ runId: "r", turnId: "t", threadId: "thread", environmentId: "env", reason: "test" });
  }).pipe(Effect.provide(ScreenRunService.layerWithRuntime({
    dispatcher: host,
    invocation: { command: process.execPath, entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)) },
    assetResolver: () => resolveScreenRuntimeAsset("dev"),
  }).pipe(Layer.provide(NodeServices.layer))));
});
