import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import type { ScreenElementRef, ScreenTargetRef } from "@goat/contracts";
import { ComputerUseRefusalDetail, computerUseRefusalReason } from "@goat/contracts";
import type { ComputerUsePrimitiveChannel } from "../cua/ComputerUsePrimitiveChannel.ts";
import type { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import { ScreenObservations } from "./ScreenObservations.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import {
  context,
  call,
  apps,
  windows,
  state,
  goat2WindowState,
  DriverError,
  NotStarted,
  typedRefusal,
  fixture,
} from "./DesktopTargetHost.testkit.ts";

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
    const { host, sent } = fixture({ get_window_state: goat2WindowState });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const observed = yield* host.observe(call("get_window_state", {}, ref), context);
    const elementRef = (observed.value as { elements: Array<{ ref: ScreenElementRef }> })
      .elements[0]?.ref;
    if (!elementRef) throw new Error("The observed button must have a ref");
    const shoot = host.observe(call("screenshot", {}, ref), context);
    yield* host.invoke(call("click", { x: 10, y: 20 }, ref), context);
    yield* shoot;
    yield* host.invoke(call("right_click", { x: 10, y: 20 }, ref), context);
    yield* shoot;
    yield* host.invoke(call("drag", { from_x: 1, from_y: 2, to_x: 3, to_y: 4 }, ref), context);
    yield* shoot;
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
      "get_window_state",
      "right_click",
      "get_window_state",
      "drag",
      "get_window_state",
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

it.effect(
  "a point is refused after any input until a new screenshot, whatever call form sent it",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture({ get_window_state: goat2WindowState });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      yield* host.observe(call("screenshot", {}, ref), context);
      yield* host.invoke(call("type_text", { text: "changes the window" }, ref), context);
      for (const aimed of [
        call("click", { x: 10, y: 10 }, ref),
        call("drag", { from_x: 1, from_y: 2, to_x: 3, to_y: 4 }, ref),
        call("scroll", { x: 10, y: 10, direction: "down" }, ref),
      ]) {
        const refused = yield* host.invoke(aimed, context).pipe(Effect.result);
        expect(refused._tag === "Failure" && refused.failure).toMatchObject({
          code: "stale_reference",
          effectStarted: false,
        });
      }
      expect(sent.map((entry) => entry.tool)).not.toContain("click");
      yield* host.observe(call("screenshot", {}, ref), context);
      yield* host.invoke(call("click", { x: 10, y: 10 }, ref), context);
      expect(sent.filter((entry) => entry.tool === "click")).toHaveLength(1);
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
  "a desktop diff read is a full read, so every element keeps a ref the next input can use",
  () =>
    Effect.gen(function* () {
      // goat.7 answers a since read with typed_output_mismatch, so a since read fails the cell.
      const { host, sent } = fixture({
        get_window_state: (args: Record<string, unknown>) =>
          args.since === undefined
            ? goat2WindowState(args)
            : new DriverError({ code: "typed_output_mismatch", execution_state: "unknown" }),
      });
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
      expect(full.mode).toBe("full");

      const again = yield* observe({ mode: "diff", baseObservationId: full.observationId });
      expect(sent.at(-1)?.args).not.toHaveProperty("since");
      expect(again).toMatchObject({ mode: "full", resetReason: "desktop_reads_full" });
      expect(again.elements.map((element) => element.name)).toEqual(["Document", "Apply"]);
      yield* host.invoke(call("click", { elementRef: refAt(again, 1) }, ref), context);
      expect(sent.at(-1)).toMatchObject({ tool: "click", args: { element_token: "s0000000a:1" } });

      // The earlier read's refs retire with its observation, before any input.
      const before = sent.length;
      const retired = yield* host
        .invoke(call("click", { elementRef: refAt(full, 1) }, ref), context)
        .pipe(Effect.result);
      expect(retired._tag === "Failure" && retired.failure.code).toBe("stale_reference");
      expect(sent).toHaveLength(before);
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
      expect(sent.at(-1)?.args).not.toHaveProperty("since");
      expect(diff.mode).toBe("full");

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
      expect(safety?.possibleCommit).toBe(effect !== "refused");
      expect(safety?.retryClass).toBe(effect === "refused" ? "fix_input" : "never");
    }),
);

// cua-driver 0.38 refuses any argument outside a tool's schema (`press_key: unknown argument ...`).
const PRESS_KEY_ARGUMENTS = new Set([
  "delivery_mode",
  "element_token",
  "key",
  "modifiers",
  "pid",
  "post_action_wait",
  "scope",
  "target",
  "window_id",
  "x",
  "y",
]);
const strictPressKey = (args: unknown) => {
  const unknown = Object.keys(args as object).find((key) => !PRESS_KEY_ARGUMENTS.has(key));
  if (unknown === undefined) return { effect: "unverifiable" };
  const message = `press_key: unknown argument ${unknown}`;
  return new DriverError(
    { status: "refused", refusal: { code: "invalid_arguments", message } },
    message,
  );
};

it.live("a guest's key press reaches a driver that refuses unknown arguments", () => {
  const { host, sent } = fixture({ press_key: strictPressKey });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source:
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); await app.pressKey({key: 'escape'});",
    });
    expect(result.status).toBe("completed");
    expect(sent.at(-1)).toMatchObject({ tool: "press_key", args: { key: "escape" } });
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
    });
  }).pipe(Effect.provide(cellService(host)));
});

it.effect("a driver's argument refusal is an input error that says what the driver refused", () =>
  Effect.gen(function* () {
    const message = "press_key: unknown argument shout";
    const { host } = fixture({
      press_key: new DriverError(
        { status: "refused", refusal: { code: "invalid_arguments", message } },
        message,
      ),
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const error = yield* host
      .invoke(call("press_key", { key: "a", shout: true }, bound.value as ScreenTargetRef), context)
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      code: "invalid_argument",
      effectStarted: false,
      nextStep: message,
    });
  }),
);

it.effect("GOAT's refusal tells the agent why, what to do, and which thread holds the window", () =>
  Effect.gen(function* () {
    const message =
      "Thread thread:holder is using this target. This call did not run; wait for that thread to finish, then observe again.";
    const { host } = fixture({
      click: new NotStarted(
        {
          refused: "targetRefused",
          detail: "target_busy",
          holderThreadId: "thread:holder",
        },
        message,
      ),
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const error = yield* host
      .invoke(call("click", { x: 1, y: 2 }, bound.value as ScreenTargetRef), context)
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      refused: "targetRefused",
      detail: "target_busy",
      holderThreadId: "thread:holder",
      nextStep: message,
      effectStarted: false,
    });
  }),
);

// A full Finder read passes the primitive channel's size cap, and the lease proxy sends a marker
// in its place: the read ran, so the agent hears the limit and keeps its binding.
it.effect("a window read too large for the primitive channel fails as tree_limit, not stale", () =>
  Effect.gen(function* () {
    let reads = 0;
    const { host, sent } = fixture({
      get_window_state: () =>
        reads++ === 1
          ? {
              code: "primitive_reply_too_large",
              message: "Driver reply exceeded the primitive channel limit.",
              bytes: 2_000_000,
              maxBytes: 1_048_576,
            }
          : state,
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const target = bound.value as ScreenTargetRef;
    const first = yield* host.observe(call("get_window_state", {}, target), context);
    const elementRef = (first.value as { elements: Array<{ ref: ScreenElementRef }> }).elements[0]
      ?.ref;
    const tooLarge = yield* host
      .observe(call("get_window_state", {}, target), context)
      .pipe(Effect.result);
    if (!elementRef) throw new Error("The first read must offer a ref");
    expect(tooLarge._tag === "Failure" && tooLarge.failure.code).toBe("tree_limit");
    // That read retired the driver's earlier tokens, so the earlier ref never reaches it.
    const sentBefore = sent.length;
    const click = yield* host
      .invoke(call("click", { elementRef }, target), context)
      .pipe(Effect.result);
    expect(click._tag === "Failure" && click.failure.code).toBe("stale_reference");
    expect(sent.length).toBe(sentBefore);
    const again = yield* host.observe(call("get_window_state", {}, target), context);
    expect(again.value).toMatchObject({ indexedText: "Apply" });
    const shapeless = fixture({ get_window_state: { elements: [] } });
    const other = yield* shapeless.host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const unknown = yield* shapeless.host
      .observe(call("get_window_state", {}, other.value as ScreenTargetRef), context)
      .pipe(Effect.result);
    expect(unknown._tag === "Failure" && unknown.failure.code).toBe("downstream_failure");
  }),
);
