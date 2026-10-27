import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import type {
  ComputerUsePrimitiveReply,
  ScreenElementRef,
  ScreenHostCall,
  ScreenTargetRef,
  ThreadId,
} from "@goat/contracts";
import { ComputerUseRefusalDetail, computerUseRefusalReason } from "@goat/contracts";
import type { ComputerUsePrimitiveChannel } from "../cua/ComputerUsePrimitiveChannel.ts";
import type { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import { ScreenObservations } from "./ScreenObservations.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import type { ScreenHostContext } from "./ScreenHostBridge.ts";
import { screenRunLimits } from "./ScreenRunLimits.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const context = {
  runId: "r",
  turnId: "t",
  cellId: "c",
  threadId: "thread",
  environmentId: "env",
  limits: screenRunLimits(),
  invocation: { thread: { threadId: "thread" as ThreadId } },
} as ScreenHostContext;
const call = (
  method: ScreenHostCall["method"],
  args: ScreenHostCall["args"] = {},
  targetRef?: ScreenTargetRef,
): ScreenHostCall => ({
  t: "call",
  runId: "r",
  turnId: "t",
  cellId: "c",
  callId: 1,
  method,
  args,
  deadlineMillis: 1000,
  ...(targetRef ? { targetRef } : {}),
});
const apps = { apps: [{ pid: 42, name: "Editor", bundle_id: "org.example.Editor" }] };
const windows = { windows: [{ pid: 42, window_id: 7, title: "Document" }] };
const state = {
  pid: 42,
  window_id: 7,
  tree_markdown: "Apply",
  elements_complete: true,
  elements: [{ role: "button", label: "Apply", element_token: "snapshot:1" }],
};

// Reads shaped as cua-driver-rs-v0.38.0-goat.2 returns them (core window_state_view.rs apply,
// macOS get_window_state.rs): tokens are <snapshot_id>:N, elements_complete is always false.
const goat2Element = (snapshot: string, index: number, role: string, label: string) => ({
  role,
  depth: 1,
  element_index: index,
  element_token: `${snapshot}:${index}`,
  label,
});
const goat2Full = (snapshot: string) => ({
  window_id: 7,
  pid: 42,
  element_count: 2,
  returned_element_count: 2,
  elements_complete: false,
  snapshot_id: snapshot,
  tree_markdown: '- [0] AXWindow "Document"\n  - [1] AXButton "Apply" [actions=[press]]',
  elements: [
    goat2Element(snapshot, 0, "AXWindow", "Document"),
    goat2Element(snapshot, 1, "AXButton", "Apply"),
  ],
});
/** goat.2 keeps only the requested tree representation; markdown is its default. */
const goat2Read = (read: ReturnType<typeof goat2Full>, args: Record<string, unknown>) => {
  const format = typeof args.tree_format === "string" ? args.tree_format : "markdown";
  const { elements, tree_markdown, ...rest } = read;
  return {
    ...rest,
    tree_format: format,
    ...(format === "markdown" ? {} : { elements }),
    ...(format === "elements" ? {} : { tree_markdown }),
  };
};
const goat2Diff = {
  window_id: 7,
  pid: 42,
  elements_complete: false,
  snapshot_id: "s0000000b",
  since: "s0000000a",
  since_status: "diff",
  tree_diff:
    'since s0000000a: 1 added, 0 changed, 0 removed. Use element_tokens s0000000b:N for + and ~ rows and unchanged rows; - ids are from s0000000a.\n+ [2] AXButton "Save" [actions=[press]]',
  diff_counts: { added: 1, changed: 0, removed: 0 },
  elements: [goat2Element("s0000000b", 2, "AXButton", "Save")],
  tree_format: "both",
};
const goat2NoChange = {
  window_id: 7,
  pid: 42,
  elements_complete: false,
  snapshot_id: "s0000000d",
  since: "s0000000b",
  since_status: "no_change",
  tree_diff:
    "no change since s0000000b. Rows and indices are as before; use snapshot_id s0000000d in element_tokens (s0000000d:N).",
  diff_counts: { added: 0, changed: 0, removed: 0 },
  elements: [],
  tree_format: "both",
};
const goat2WindowState = (
  args: Record<string, unknown>,
  screenshot: Record<string, unknown> = { snapshot_id: "s0000000a" },
) =>
  args.include_accessibility_tree === false
    ? {
        window_id: 7,
        pid: 42,
        elements_complete: false,
        tree_markdown: "",
        tree_format: "markdown",
        screenshot_width: 100,
        screenshot_height: 80,
        screenshot_mime_type: "image/png",
        window_bounds: { x: 10, y: 20, width: 50, height: 40 },
        screenshot_scale: 2,
        image: {
          mimeType: "image/png",
          bytes: Buffer.from("png").toString("base64"),
          width: 100,
          height: 80,
        },
        ...screenshot,
      }
    : args.since === "s0000000a"
      ? goat2Diff
      : args.since === "s0000000b"
        ? goat2NoChange
        : args.since !== undefined
          ? {
              ...goat2Read(goat2Full("s0000000c"), args),
              since: args.since,
              since_status: "unknown_snapshot",
            }
          : goat2Read(goat2Full("s0000000a"), args);

/** A driver tools/call answer with isError, as the lease proxy forwards a refusal. */
class DriverError {
  readonly structuredContent: Record<string, unknown>;
  constructor(structuredContent: Record<string, unknown>) {
    this.structuredContent = structuredContent;
  }
}
/** A call GOAT refused before the driver: the proxy answers not_started with its refusal. */
class NotStarted extends DriverError {}
// The typed refusal fields the lease proxy adds to a driver reply it refused.
const typedRefusal = {
  effect: "refused",
  refused: "appNotAllowed",
  detail: "app_not_approved",
  app: "org.example.Editor",
};

const fixture = (
  override: Partial<Record<string, unknown>> = {},
  connection = { id: "driver:1" },
  observations?: ScreenObservations,
) => {
  const sent: Array<{ tool: string; args: unknown; expectedConnectionGeneration?: string }> = [];
  const channel = {
    request: (request: { tool: string; args: unknown; expectedConnectionGeneration?: string }) =>
      request.expectedConnectionGeneration !== undefined &&
      request.expectedConnectionGeneration !== connection.id
        ? Effect.fail({
            code: "stale_reference" as const,
            effectStarted: false,
            nextStep: "Bind again.",
          })
        : Effect.sync(() => {
            sent.push({
              tool: request.tool,
              args: request.args,
              ...(request.expectedConnectionGeneration === undefined
                ? {}
                : { expectedConnectionGeneration: request.expectedConnectionGeneration }),
            });
            const answer =
              override[request.tool] ??
              (request.tool === "list_apps"
                ? apps
                : request.tool === "list_windows"
                  ? windows
                  : request.tool === "get_window_state"
                    ? state
                    : { effect: "confirmed", evidence: ["driver:acted"] });
            const value =
              typeof answer === "function"
                ? (answer as (args: unknown) => unknown)(request.args)
                : answer;
            return {
              status: value instanceof NotStarted ? "not_started" : "settled",
              connectionGeneration: connection.id,
              result:
                value instanceof DriverError
                  ? { isError: true, structuredContent: value.structuredContent }
                  : { structuredContent: value },
              ...(request.tool === "get_window_state" &&
              typeof (value as { image?: unknown }).image === "object"
                ? { image: (value as { image: unknown }).image }
                : {}),
            } as unknown as ComputerUsePrimitiveReply;
          }),
  } as unknown as ComputerUsePrimitiveChannel["Service"];
  const leases = {
    currentControl: () => Effect.succeedSome({ controlId: "control" }),
    controlState: () => Effect.succeed({ _tag: "active", idle: false }),
    releaseForeground: () => Effect.succeed(true),
  } as unknown as ComputerUseLeases["Service"];
  return {
    host: createDesktopTargetHost({
      primitiveChannel: channel,
      leases,
      ...(observations ? { observations } : {}),
    }),
    sent,
  };
};

it.effect(
  "a desktop ref bound before a driver restart is refused before input after the restart",
  () =>
    Effect.gen(function* () {
      const connection = { id: "driver:1" };
      const { host, sent } = fixture({}, connection);
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      connection.id = "driver:2";
      const result = yield* host
        .invoke(call("click", { x: 1, y: 2 }, bound.value as ScreenTargetRef), context)
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe("stale_reference");
        expect(result.failure.effectStarted).toBe(false);
      }
      expect(sent.map((entry) => entry.tool)).toEqual(["list_apps", "list_windows"]);
    }),
);

it.effect("binding the same window in another turn preserves the first turn's ref", () =>
  Effect.gen(function* () {
    const { host } = fixture();
    const first = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const nextContext = { ...context, runId: "r2", turnId: "t2" };
    const nextCall = {
      ...call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      runId: "r2",
      turnId: "t2",
    };
    yield* host.bindApp(nextCall, nextContext);
    const observed = yield* host.observe(
      call("get_window_state", {}, first.value as ScreenTargetRef),
      context,
    );
    expect(observed.value).toMatchObject({ indexedText: "Apply" });
  }),
);

it.effect("a desktop capture larger than the JSON cap reaches the host as a bounded image", () =>
  Effect.gen(function* () {
    const bytes = Buffer.alloc(80 * 1024, 1).toString("base64");
    const { host } = fixture({
      get_window_state: {
        ...state,
        screenshot_width: 100,
        screenshot_height: 100,
        image: { mimeType: "image/png", bytes, width: 100, height: 100 },
      },
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const capture = yield* host.observe(
      call("screenshot", {}, bound.value as ScreenTargetRef),
      context,
    );
    expect(capture.image?.bytes).toBe(bytes);
    expect(capture.imageMetadata?.pixelWidth).toBe(100);
  }),
);

it.effect("ambiguous app/window binding refuses input", () =>
  Effect.gen(function* () {
    // Two processes of the app each report a window with the asked-for id.
    const { host, sent } = fixture({
      list_apps: { apps: [apps.apps[0], { ...apps.apps[0], pid: 43 }] },
      list_windows: { windows: [windows.windows[0], { ...windows.windows[0], pid: 43 }] },
    });
    const result = yield* host
      .bindApp(call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }), context)
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("target_ambiguous");
    expect(sent.map((entry) => entry.tool)).toEqual(["list_apps", "list_windows"]);
    const windowFixture = fixture({
      list_windows: { windows: [windows.windows[0], windows.windows[0]] },
    });
    const ambiguousWindow = yield* windowFixture.host
      .bindApp(call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }), context)
      .pipe(Effect.result);
    expect(ambiguousWindow._tag).toBe("Failure");
    if (ambiguousWindow._tag === "Failure")
      expect(ambiguousWindow.failure.code).toBe("target_ambiguous");
    expect(windowFixture.sent.map((entry) => entry.tool)).toEqual(["list_apps", "list_windows"]);
  }),
);

// Linux list_apps reports every /proc process and installed launcher; on a real Ubuntu desktop
// that reply passes the lease proxy's 64 KiB cap and arrives as this placeholder.
it.effect("a window binds when the driver's app list exceeds the primitive channel limit", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      list_apps: { message: "Driver reply exceeded the primitive channel limit." },
      list_windows: (args: { app?: string }) =>
        args.app === "org.example.Editor" ? windows : { windows: [] },
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    expect(sent.map((entry) => [entry.tool, entry.args])).toEqual([
      ["list_apps", {}],
      ["list_windows", { app: "org.example.Editor" }],
    ]);
    const observed = yield* host.observe(
      call("get_window_state", {}, bound.value as ScreenTargetRef),
      context,
    );
    expect(observed.value).toMatchObject({ indexedText: "Apply" });
    expect(sent.at(-1)?.args).toMatchObject({ pid: 42, window_id: 7 });
  }),
);

it.effect("two processes of one app bind the window the agent named", () =>
  Effect.gen(function* () {
    const second = { ...apps.apps[0], pid: 43 };
    const { host, sent } = fixture({
      list_apps: { apps: [apps.apps[0], second] },
      list_windows: (args: { app?: string }) =>
        args.app === "org.example.Editor"
          ? { windows: [windows.windows[0], { pid: 43, window_id: 8, title: "Other" }] }
          : { windows: [] },
      get_window_state: { ...state, pid: 43, window_id: 8 },
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 8 }),
      context,
    );
    yield* host.observe(call("get_window_state", {}, bound.value as ScreenTargetRef), context);
    expect(sent.at(-1)?.args).toMatchObject({ pid: 43, window_id: 8 });
  }),
);

it.effect(
  "a capped app list does not bind a window of an app whose name only contains the one asked for",
  () =>
    Effect.gen(function* () {
      const { host } = fixture({
        list_apps: { message: "Driver reply exceeded the primitive channel limit." },
        list_windows: (args: { app?: string }) =>
          args.app === "Edit"
            ? { windows: [{ pid: 9, window_id: 7, title: "dump.bin", app_name: "HexEditor" }] }
            : { windows: [] },
      });
      const result = yield* host
        .bindApp(call("bind_app", { name: "Edit", window_id: 7 }), context)
        .pipe(Effect.result);
      expect(result._tag === "Failure" && result.failure.code).toBe("target_missing");
    }),
);

it.effect("binding an app the driver does not list reports it missing", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({ list_apps: { apps: [] } });
    const result = yield* host
      .bindApp(call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }), context)
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("target_missing");
    expect(sent.map((entry) => entry.tool)).toEqual(["list_apps"]);
  }),
);

it.effect(
  "ScreenObservations alone mints desktop refs and stale element refs refuse before driver send",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture();
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const observed = yield* host.observe(call("get_window_state", {}, ref), context);
      const observation = observed.value as {
        observationId: string;
        elements: Array<{ ref: unknown }>;
      };
      expect(observation.elements[0]?.ref).toBeDefined();
      const stale = yield* host
        .invoke(
          call(
            "click",
            { elementRef: { ...(observation.elements[0]?.ref as object), observationId: "old" } },
            ref,
          ),
          context,
        )
        .pipe(Effect.result);
      expect(stale._tag).toBe("Failure");
      if (stale._tag === "Failure") expect(stale.failure.code).toBe("stale_reference");
      expect(sent.map((entry) => entry.tool)).toEqual([
        "list_apps",
        "list_windows",
        "get_window_state",
      ]);
    }),
);

it.effect("desktop actions map only to allowed driver primitives", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture();
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const observed = yield* host.observe(call("get_window_state", {}, ref), context);
    const elementRef = (observed.value as { elements: Array<{ ref: ScreenElementRef }> })
      .elements[0]?.ref;
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
      "list_apps",
      "list_windows",
      "get_window_state",
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
    expect(sent[3]?.args).toMatchObject({
      target: { kind: "window", pid: 42, window_id: 7 },
      x: 10,
      y: 20,
    });
  }),
);

type Observed = {
  observationId: string;
  mode: string;
  baseObservationId?: string;
  resetReason?: string;
  indexedText: string;
  elements: Array<{ name: string; ref: ScreenElementRef }>;
};
const refAt = (observed: Observed, index: number) => {
  const ref = observed.elements[index]?.ref;
  if (!ref) throw new Error(`The observation must have element `);
  return ref;
};

it.effect(
  "a desktop read asks goat.2 for elements beside the tree and a diff read sends the base snapshot as since",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture({ get_window_state: goat2WindowState });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const observe = (args: Record<string, string>) =>
        host
          .observe(call("get_accessibility_tree", args, ref), context)
          .pipe(Effect.map((result) => result.value as Observed));
      const full = yield* observe({});
      expect(sent.at(-1)?.args).toMatchObject({ tree_format: "both" });
      expect(sent.at(-1)?.args).not.toHaveProperty("since");
      expect(full.mode).toBe("full");
      expect(full.elements.map((element) => element.name)).toEqual(["Document", "Apply"]);

      const diff = yield* observe({ mode: "diff", baseObservationId: full.observationId });
      expect(sent.at(-1)?.args).toMatchObject({ tree_format: "both", since: "s0000000a" });
      expect(diff).toMatchObject({
        mode: "diff",
        baseObservationId: full.observationId,
        indexedText: goat2Diff.tree_diff,
      });
      expect(diff.elements.map((element) => element.name)).toEqual(["Save"]);
      const save = diff.elements[0]?.ref;
      if (!save) throw new Error("The added row must have a ref");
      yield* host.invoke(call("click", { elementRef: save }, ref), context);
      expect(sent.at(-1)?.args).toMatchObject({ element_token: "s0000000b:2" });
      // The driver retired the base snapshot's tokens, so the base read's refs refuse before input.
      const before = sent.length;
      const retired = yield* host
        .invoke(call("click", { elementRef: refAt(full, 1) }, ref), context)
        .pipe(Effect.result);
      expect(retired._tag === "Failure" && retired.failure.code).toBe("stale_reference");
      expect(sent).toHaveLength(before);

      const unchanged = yield* observe({ mode: "diff", baseObservationId: diff.observationId });
      expect(sent.at(-1)?.args).toMatchObject({ since: "s0000000b" });
      expect(unchanged).toMatchObject({ mode: "diff", indexedText: goat2NoChange.tree_diff });
      expect(unchanged.elements).toEqual([]);
      const stillRetired = yield* host
        .invoke(call("click", { elementRef: save }, ref), context)
        .pipe(Effect.result);
      expect(stillRetired._tag === "Failure" && stillRetired.failure.code).toBe("stale_reference");

      // The driver no longer knows the base snapshot: it reads the whole tree and says why.
      const fallback = yield* observe({ mode: "diff", baseObservationId: unchanged.observationId });
      expect(sent.at(-1)?.args).toMatchObject({ since: "s0000000d" });
      expect(fallback).toMatchObject({ mode: "full", resetReason: "unknown_snapshot" });
      expect(fallback.elements).toHaveLength(2);

      const notCurrent = yield* observe({ mode: "diff", baseObservationId: full.observationId });
      expect(sent.at(-1)?.args).not.toHaveProperty("since");
      expect(notCurrent).toMatchObject({ mode: "full", resetReason: "unknown_base_observation" });
    }),
);

it.effect(
  "a desktop screenshot keeps the tree's element refs only while the driver keeps its snapshot",
  () =>
    Effect.gen(function* () {
      let screenshot: Record<string, unknown> = { snapshot_id: "s0000000a" };
      const { host, sent } = fixture({
        get_window_state: (args: Record<string, unknown>) => goat2WindowState(args, screenshot),
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const tree = (yield* host.observe(call("get_accessibility_tree", {}, ref), context))
        .value as Observed;
      const capture = yield* host.observe(call("screenshot", {}, ref), context);
      expect(sent.at(-1)?.args).toMatchObject({ include_accessibility_tree: false });
      expect(capture.imageMetadata?.observationId).toBe(tree.observationId);
      const apply = tree.elements.find((element) => element.name === "Apply")?.ref;
      if (!apply) throw new Error("The tree must have the Apply button");
      yield* host.invoke(call("click", { elementRef: apply }, ref), context);
      expect(sent.at(-1)).toMatchObject({ tool: "click", args: { element_token: "s0000000a:1" } });
      const diff = (yield* host.observe(
        call(
          "get_accessibility_tree",
          { mode: "diff", baseObservationId: tree.observationId },
          ref,
        ),
        context,
      )).value as Observed;
      expect(sent.at(-1)?.args).toMatchObject({ since: "s0000000a" });
      expect(diff.mode).toBe("diff");

      // Another snapshot, the tree's snapshot invalidated, or no snapshot named: refs retire.
      for (const replacing of [
        { snapshot_id: "s0000000e" },
        { snapshot_id: "s0000000a", invalidated_snapshot_ids: ["s0000000a"] },
        { snapshot_id: undefined },
      ]) {
        const next = (yield* host.observe(call("get_accessibility_tree", {}, ref), context))
          .value as Observed;
        screenshot = replacing;
        const replaced = yield* host.observe(call("screenshot", {}, ref), context);
        expect(replaced.imageMetadata?.observationId).not.toBe(next.observationId);
        const before = sent.length;
        const stale = yield* host
          .invoke(call("click", { elementRef: refAt(next, 1) }, ref), context)
          .pipe(Effect.result);
        expect(stale._tag === "Failure" && stale.failure.code).toBe("stale_reference");
        expect(sent).toHaveLength(before);
      }
    }),
);

it.effect("a desktop read that fails to render still retires the refs the driver replaced", () =>
  Effect.gen(function* () {
    class SecondRenderFails extends ScreenObservations {
      renders = 0;
      override renderObservation(input: Parameters<ScreenObservations["renderObservation"]>[0]) {
        if (++this.renders === 2)
          throw new Error("Screen observation metadata exceeds tree budget");
        return super.renderObservation(input);
      }
    }
    for (const method of ["get_accessibility_tree", "screenshot"] as const) {
      const { host, sent } = fixture(
        {
          get_window_state: (args: Record<string, unknown>) =>
            goat2WindowState(args, { snapshot_id: "s0000000e" }),
        },
        undefined,
        new SecondRenderFails(),
      );
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const tree = (yield* host.observe(call("get_accessibility_tree", {}, ref), context))
        .value as Observed;
      const failed = yield* host.observe(call(method, {}, ref), context).pipe(Effect.result);
      expect(failed._tag === "Failure" && failed.failure.code).toBe("tree_limit");
      const before = sent.length;
      const stale = yield* host
        .invoke(call("click", { elementRef: refAt(tree, 1) }, ref), context)
        .pipe(Effect.result);
      expect(stale._tag === "Failure" && stale.failure.code).toBe("stale_reference");
      expect(sent).toHaveLength(before);
    }
  }),
);

it.effect("desktop select_text is unsupported before any target lookup and sends nothing", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture();
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const stale: ScreenTargetRef = { ...(bound.value as ScreenTargetRef), id: "gone" };
    for (const ref of [bound.value as ScreenTargetRef, stale]) {
      const result = yield* host
        .dispatch(call("select_text", { start: 0, end: 3 }, ref), context)
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({ code: "unsupported", effectStarted: false });
        expect(result.failure.nextStep).toContain("nothing was sent");
        expect(result.failure.nextStep).toContain("setValue");
      }
    }
    expect(sent.map((entry) => entry.tool)).toEqual(["list_apps", "list_windows"]);
  }),
);

it.effect("desktop discovery reports desktop_not_ready before a driver is bound", () =>
  Effect.gen(function* () {
    const { host } = fixture();
    const channel = {
      request: () =>
        Effect.fail({
          code: "unavailable",
          reason: "desktop_not_ready",
          effectStarted: false,
          nextStep: "Wait for desktop control.",
        }),
    } as unknown as ComputerUsePrimitiveChannel["Service"];
    const unavailableHost = createDesktopTargetHost({
      primitiveChannel: channel,
      leases: {
        currentControl: () => Effect.succeedNone,
      } as unknown as ComputerUseLeases["Service"],
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
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source:
        "const apps = await screen.list_apps({}); const windows = await screen.list_windows({}); return [apps.apps.length, windows.windows.length];",
    });
    expect(result.value).toEqual([1, 1]);
    expect(sent.map((entry) => entry.tool)).toEqual(["list_apps", "list_windows"]);
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
    });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: host,
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

it.live("launch_app can start an app before it has a bound window", () => {
  const { host, sent } = fixture();
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source: "return await screen.launch_app({bundle_id: 'org.example.Editor'});",
    });
    expect(result.value).toMatchObject({ effect: "confirmed" });
    expect(sent).toEqual([{ tool: "launch_app", args: { bundle_id: "org.example.Editor" } }]);
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
    });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

it.live("a guest binds and clicks an app window through the admitted channel", () => {
  const { host, sent } = fixture();
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source:
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); return await app.click({x: 1, y: 2});",
    });
    expect(result.status).toBe("completed");
    expect(sent.map((entry) => entry.tool)).toEqual(["list_apps", "list_windows", "click"]);
    expect(sent[2]?.args).toMatchObject({
      target: { kind: "window", pid: 42, window_id: 7 },
      x: 1,
      y: 2,
    });
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
    });
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );
});

it.live(
  "a driver refusal keeps its refused, detail and app in the cell's error and receipt",
  () => {
    const { host, sent } = fixture({ click: new DriverError(typedRefusal) });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      // The cell's awaited click fails the run with the host's typed error.
      const error = yield* service
        .runCell({
          runId: "r",
          turnId: "t",
          threadId: "thread",
          environmentId: "env",
          invocation: context.invocation,
          source:
            "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); return await app.click({x: 1, y: 2});",
        })
        .pipe(Effect.flip);
      const refusal = {
        refused: "appNotAllowed",
        detail: "app_not_approved",
        app: "org.example.Editor",
      };
      expect(error).toMatchObject({
        code: "permission_denied",
        effectStarted: false,
        ...refusal,
      });
      expect("receipts" in error ? error.receipts?.at(-1) : undefined).toMatchObject({
        method: "click",
        category: "refused",
        dispatched: false,
        ...refusal,
      });
      expect(sent.map((entry) => entry.tool)).toEqual(["list_apps", "list_windows", "click"]);
      yield* service.finishTurn({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        reason: "test",
      });
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ app: host }),
          invocation: {
            command: process.execPath,
            entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
          },
          assetResolver: () => resolveScreenRuntimeAsset("dev"),
        }).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
  },
);

const cellService = (host: ReturnType<typeof fixture>["host"]) =>
  ScreenRunService.layerWithRuntime({
    dispatcher: createScreenDispatchRouter({ app: host }),
    invocation: {
      command: process.execPath,
      entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
    },
    assetResolver: () => resolveScreenRuntimeAsset("dev"),
  }).pipe(Layer.provide(NodeServices.layer));

it.live(
  "a cell whose click committed reports possibleCommit after its receipts are cut or a script throws",
  () => {
    const { host } = fixture({
      type_text: new NotStarted({ refused: "targetRefused", detail: "target_busy" }),
    });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const run = (cellSource: string) =>
        service.runCell({
          runId: "r",
          turnId: "t",
          threadId: "thread",
          environmentId: "env",
          invocation: context.invocation,
          source:
            "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.click({x: 1, y: 2}); for (let i = 0; i < 16; i++) await screen.list_apps(); " +
            cellSource,
        });
      // Sixteen reads push the committed click out of the error's receipts.
      const refused = yield* run("await app.typeText({text: 'x'});").pipe(Effect.flip);
      expect(refused.receipts?.some((receipt) => receipt.method === "click")).toBe(false);
      expect(refused.receipts?.at(-1)).toMatchObject({
        method: "type_text",
        detail: "target_busy",
      });
      expect(refused.safety).toMatchObject({ possibleCommit: true, retryClass: "never" });
      const thrown = yield* run("throw new Error('boom');");
      expect(thrown.error).toMatchObject({
        message: expect.stringContaining("boom"),
        safety: { possibleCommit: true, retryClass: "never" },
      });
      yield* service.finishTurn({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        reason: "test",
      });
    }).pipe(Effect.provide(cellService(host)));
  },
);

it.effect("a refused status without an effect is a refusal with nothing started", () =>
  Effect.gen(function* () {
    const { effect: _effect, ...fields } = typedRefusal;
    const { host } = fixture({ click: new DriverError({ ...fields, status: "refused" }) });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const result = yield* host
      .invoke(call("click", { x: 1, y: 2 }, bound.value as ScreenTargetRef), context)
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({
        code: "permission_denied",
        effectStarted: false,
        refused: "appNotAllowed",
        detail: "app_not_approved",
        app: "org.example.Editor",
      });
  }),
);

it.effect(
  "every refusal detail the contract knows reaches the error, and unknown or oversized fields do not",
  () =>
    Effect.gen(function* () {
      const refuse = (structuredContent: Record<string, unknown>) =>
        Effect.gen(function* () {
          const { host } = fixture({ click: new DriverError(structuredContent) });
          const bound = yield* host.bindApp(
            call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
            context,
          );
          return yield* host
            .invoke(call("click", { x: 1, y: 2 }, bound.value as ScreenTargetRef), context)
            .pipe(Effect.flip);
        });
      for (const detail of ComputerUseRefusalDetail.literals) {
        const refused = computerUseRefusalReason(detail);
        const error = yield* refuse({
          effect: "refused",
          refused,
          detail,
          app: "org.example.Editor",
        });
        expect(error).toMatchObject({
          code: "permission_denied",
          effectStarted: false,
          refused,
          detail,
        });
      }
      const unknown = yield* refuse({
        effect: "refused",
        refused: "notAReason",
        detail: "not_a_detail",
        app: "x".repeat(201),
      });
      expect(unknown).toMatchObject({ code: "permission_denied", effectStarted: false });
      expect(unknown).not.toHaveProperty("refused");
      expect(unknown).not.toHaveProperty("detail");
      expect(unknown).not.toHaveProperty("app");
      // An explicit effect outranks a refused status: the input may have landed.
      const landed = yield* refuse({ ...typedRefusal, effect: "unverifiable", status: "refused" });
      expect(landed).toMatchObject({ code: "unknown_outcome", effectStarted: true });
    }),
);

it.effect.each(["unknown", "partial", "suspected_noop", "refused", "confirmed"])(
  "desktop action safety preserves the driver's %s outcome",
  (effect) =>
    Effect.gen(function* () {
      const { host } = fixture({ click: { effect } });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const result = yield* host
        .invoke(call("click", { x: 10, y: 20 }, bound.value as ScreenTargetRef), context)
        .pipe(Effect.result);
      const safety = result._tag === "Success" ? result.success.safety : result.failure.safety;
      expect(safety?.possibleCommit).toBe(effect !== "suspected_noop" && effect !== "refused");
      expect(safety?.retryClass).toBe(
        effect === "suspected_noop" || effect === "refused" ? "fix_input" : "never",
      );
    }),
);
