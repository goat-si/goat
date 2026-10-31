import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import type { ScreenObservation, ScreenRunError, ScreenTargetRef } from "@goat/contracts";
import { call, context, fixture } from "./DesktopTargetHost.testkit.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const entry = (index: number, role: string, label?: string) => ({
  role,
  depth: 1,
  element_index: index,
  element_token: `s1:${index}`,
  ...(label === undefined ? {} : { label }),
});

const window = (tree: ReadonlyArray<string>, extra: Record<string, unknown> = {}) => ({
  pid: 42,
  window_id: 7,
  elements_complete: true,
  tree_markdown: tree.join("\n"),
  elements: [
    entry(0, "AXWindow", "Test"),
    entry(1, "AXGroup"),
    entry(2, "AXButton", "OK"),
    entry(3, "AXButton", "Inner"),
  ],
  ...extra,
});

const tree = [
  '- [0] AXWindow "Test"',
  "  - [1] AXGroup",
  '    - AXStaticText = "Chip"',
  '    - AXStaticText = "Apple"',
  '    - [3] AXButton "Inner"',
  '  - [2] AXButton "OK"',
];

const refOf = (observation: ScreenObservation, index: number) => {
  const ref = observation.elements.find((each) => each.index === index)?.ref;
  if (ref === undefined) throw new Error(`no [${index}] in the observation`);
  return ref;
};

const bind = (host: ReturnType<typeof fixture>["host"]) =>
  host
    .bindApp(call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }), context)
    .pipe(Effect.map((bound) => bound.value as ScreenTargetRef));

it.effect("a depth read counts every child the driver returned, paired texts included", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({ get_window_state: window(tree) });
    const target = yield* bind(host);
    const depth = (yield* host.observe(call("get_window_state", { depth: 1 }, target), context))
      .value as ScreenObservation;
    expect(depth.scope).toBe("window depth 1");
    expect(depth.indexedText).toContain("- [1] AXGroup (+3)");
    expect(depth.indexedText).not.toContain("Inner");
    expect(depth.complete).toBe(false);
    expect(depth.elements.map((each) => each.index).sort()).toEqual([0, 1, 2]);
    const reads = sent.filter((each) => each.tool === "get_window_state").length;
    const within = (yield* host.observe(
      call("get_window_state", { within: 1, withinBase: depth.observationId }, target),
      context,
    )).value as ScreenObservation;
    expect(sent.filter((each) => each.tool === "get_window_state")).toHaveLength(reads);
    expect(within.scope).toBe("within [1]");
    expect(within.indexedText).toContain('AXStaticText = "Chip"');
    expect(within.indexedText).toContain('AXStaticText = "Apple"');
    expect(within.indexedText).toContain('[3] AXButton "Inner"');
    expect(within.indexedText).not.toContain('"OK"');
    // The depth read's numbers still act: [2] was never in the within page.
    const clicked = yield* host.invoke(
      call("click", { elementRef: refOf(depth, 2) }, target),
      context,
    );
    expect(clicked).toBeDefined();
    expect(sent.at(-1)).toMatchObject({ tool: "click", args: { element_token: "s1:2" } });
  }),
);

it.effect(
  "a cut walk keeps the driver's partial note out of the tree and says counts may be more",
  () =>
    Effect.gen(function* () {
      const { host } = fixture({
        get_window_state: window(
          [...tree, "", "⚠️ PARTIAL TREE: the walk stopped early; retry with a larger timeout_ms"],
          { elements_complete: false, truncated: true },
        ),
      });
      const target = yield* bind(host);
      const depth = (yield* host.observe(call("get_window_state", { depth: 1 }, target), context))
        .value as ScreenObservation;
      expect(depth.indexedText).toContain("- [1] AXGroup (+3 or more)");
      expect(depth.indexedText).not.toContain("PARTIAL TREE");
      expect(depth.complete).toBe(false);
    }),
);

it.effect(
  "a read whose text cannot carry nesting is refused for depth, and within needs the latest whole read",
  () =>
    Effect.gen(function* () {
      const spanning = fixture({
        get_window_state: window([
          '- [0] AXWindow "Test"',
          "  - [1] AXGroup",
          "loose text",
          '  - [2] AXButton "OK"',
        ]),
      });
      const spanTarget = yield* bind(spanning.host);
      const refused = yield* spanning.host
        .observe(call("get_window_state", { depth: 1 }, spanTarget), context)
        .pipe(Effect.flip);
      expect((refused as ScreenRunError).code).toBe("unsupported");
      expect((refused as ScreenRunError).effectStarted).toBe(false);

      const repeated = fixture({
        get_window_state: window(['- [0] AXWindow "Test"', "  - [1] AXGroup", "  - [1] AXGroup"]),
      });
      const repeatTarget = yield* bind(repeated.host);
      const twice = yield* repeated.host
        .observe(call("get_window_state", { depth: 1 }, repeatTarget), context)
        .pipe(Effect.flip);
      expect((twice as ScreenRunError).code).toBe("unsupported");

      const { host, sent } = fixture({ get_window_state: window(tree) });
      const target = yield* bind(host);
      const first = (yield* host.observe(call("get_window_state", { depth: 2 }, target), context))
        .value as ScreenObservation;
      yield* host.observe(call("get_window_state", {}, target), context);
      const reads = sent.length;
      const stale = yield* host
        .observe(
          call("get_window_state", { within: 1, withinBase: first.observationId }, target),
          context,
        )
        .pipe(Effect.flip);
      expect((stale as ScreenRunError).code).toBe("stale_reference");
      expect(sent).toHaveLength(reads);
    }),
);

it.effect("any input to the window ends what within can read", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({ get_window_state: window(tree) });
    const target = yield* bind(host);
    const read = (yield* host.observe(call("get_window_state", { depth: 1 }, target), context))
      .value as ScreenObservation;
    yield* host.invoke(call("click", { elementRef: refOf(read, 2) }, target), context);
    const reads = sent.filter((each) => each.tool === "get_window_state").length;
    const stale = yield* host
      .observe(
        call("get_window_state", { within: 1, withinBase: read.observationId }, target),
        context,
      )
      .pipe(Effect.flip);
    expect((stale as ScreenRunError).code).toBe("stale_reference");
    expect(sent.filter((each) => each.tool === "get_window_state")).toHaveLength(reads);
  }),
);

it.live(
  "a cell maps a window with depth, reads one region with within, and acts on the same numbers",
  () => {
    const { host, sent } = fixture({ get_window_state: window(tree) });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `const app = await screen.app({bundle_id:'org.example.Editor', window_id:7});
        const map = await app.observe({ depth: 1 });
        const region = await app.observe({ within: 1 });
        await app.click(3);
        await app.click("Test");
        let both;
        try { await app.observe({ depth: 1, within: 1 }); } catch (e) { both = [e.code, e.nothingSent]; }
        return [map.scope, region.scope, region.text.includes('Inner'), both];`,
      });
      expect(result).toMatchObject({
        status: "completed",
        value: ["window depth 1", "within [1]", true, ["invalid_argument", true]],
      });
      expect(sent.filter((each) => each.tool === "click")).toMatchObject([
        { args: { element_token: "s1:3" } },
        { args: { element_token: "s1:0" } },
      ]);
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

it.effect("children left under an unnumbered row count toward the nearest numbered one", () =>
  Effect.gen(function* () {
    const { host } = fixture({
      get_window_state: window([
        '- [0] AXWindow "Test"',
        "  - AXGroup",
        '    - [2] AXButton "OK"',
        '    - [3] AXButton "Inner"',
      ]),
    });
    const target = yield* bind(host);
    const depth = (yield* host.observe(call("get_window_state", { depth: 1 }, target), context))
      .value as ScreenObservation;
    expect(depth.indexedText).toContain('- [0] AXWindow "Test" (+2)');
  }),
);

it.effect(
  "within refuses a plain read whose text cannot carry nesting, and a driver restart ends it",
  () =>
    Effect.gen(function* () {
      const spanning = fixture({
        get_window_state: window([
          '- [0] AXWindow "Test"',
          "  - [1] AXGroup",
          "loose text",
          '  - [2] AXButton "OK"',
        ]),
      });
      const spanTarget = yield* bind(spanning.host);
      const plain = (yield* spanning.host.observe(
        call("get_window_state", {}, spanTarget),
        context,
      )).value as ScreenObservation;
      const refused = yield* spanning.host
        .observe(
          call("get_window_state", { within: 1, withinBase: plain.observationId }, spanTarget),
          context,
        )
        .pipe(Effect.flip);
      expect((refused as ScreenRunError).code).toBe("unsupported");

      const connection = { id: "driver:1" };
      const { host, sent } = fixture({ get_window_state: window(tree) }, connection);
      const target = yield* bind(host);
      const read = (yield* host.observe(call("get_window_state", { depth: 1 }, target), context))
        .value as ScreenObservation;
      connection.id = "driver:2";
      yield* host
        .invoke(call("click", { elementRef: refOf(read, 2) }, target), context)
        .pipe(Effect.flip);
      const reads = sent.filter((each) => each.tool === "get_window_state").length;
      const stale = yield* host
        .observe(
          call("get_window_state", { within: 1, withinBase: read.observationId }, target),
          context,
        )
        .pipe(Effect.flip);
      expect((stale as ScreenRunError).code).toBe("stale_reference");
      expect(sent.filter((each) => each.tool === "get_window_state")).toHaveLength(reads);
    }),
);
