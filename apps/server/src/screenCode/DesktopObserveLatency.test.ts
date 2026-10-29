import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import {
  ScreenObservation,
  screenTargetApi,
  type ScreenElementRef,
  type ScreenTargetRef,
} from "@goat/contracts";
import type { ComputerUsePrimitiveChannel } from "../cua/ComputerUsePrimitiveChannel.ts";
import { elementFrames } from "./DesktopFrames.ts";
import {
  buildObserveTiming,
  canLiftNamesFromTree,
  fastShownTree,
  withObserveTiming,
} from "./DesktopObserveLatency.ts";
import { desktopRows, shownTree } from "./DesktopObserveRead.ts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import { call, context, fixture, goat2WindowState } from "./DesktopTargetHost.testkit.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenObservations } from "./ScreenObservations.ts";
import { observationReplyBudget } from "./ScreenHostBridge.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const isObservation = Schema.is(ScreenObservation);

type RenderInput = Parameters<ScreenObservations["renderObservation"]>[0];
/**
 * Records every render: its input and output, so a test can tell a screenshot that skipped the
 * tree from one that read it, and compare what the host returned with what was rendered.
 */
class CountingObservations extends ScreenObservations {
  renders = 0;
  inputs: RenderInput[] = [];
  outputs: ScreenObservation[] = [];
  /** The render that throws the tree budget error, as an over-budget window does. */
  failOn = 0;
  override renderObservation(input: RenderInput) {
    this.renders++;
    this.inputs.push(input);
    if (this.renders === this.failOn)
      throw new Error("Screen observation metadata exceeds tree budget");
    const output = super.renderObservation(input);
    this.outputs.push(output);
    return output;
  }
}

/** A host whose every window read takes 7 ms of the test clock inside the driver call. */
const timedHost = (
  override: Parameters<typeof fixture>[0] = {},
  observations = new CountingObservations(),
) => {
  const base = fixture(override);
  const channel = {
    request: (request: { tool: string }) =>
      request.tool === "get_window_state"
        ? TestClock.adjust("7 millis").pipe(Effect.andThen(base.channel.request(request as never)))
        : base.channel.request(request as never),
  } as unknown as ComputerUsePrimitiveChannel["Service"];
  const host = createDesktopTargetHost({
    primitiveChannel: channel,
    leases: base.leases,
    observations,
    platform: "darwin",
  });
  return { host, sent: base.sent, observations };
};

const bind = (host: ReturnType<typeof timedHost>["host"]) =>
  host
    .bindApp(call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }), context)
    .pipe(Effect.map((bound) => bound.value as ScreenTargetRef));

type Timed = { ms?: number; phases?: Record<string, number> };

it.effect(
  "observe and screenshot carry their host time, with the driver call as driverMs, and match the wire contract",
  () =>
    Effect.gen(function* () {
      const { host } = timedHost({ get_window_state: goat2WindowState });
      const ref = yield* bind(host);
      const tree = (yield* host.observe(call("get_accessibility_tree", {}, ref), context)).value;
      expect(tree).toMatchObject({
        ms: 7,
        phases: { driverMs: 7, parseMs: 0, renderMs: 0, bridgeMs: 0 },
      });
      expect(isObservation(tree)).toBe(true);
      const observed = tree as ScreenObservation;
      expect(isObservation({ ...observed, phases: { ...observed.phases, driverMs: -1 } })).toBe(
        false,
      );
      const capture = yield* host.observe(call("screenshot", {}, ref), context);
      expect(capture.value).toMatchObject({
        observationId: observed.observationId,
        ms: 7,
        phases: { driverMs: 7, parseMs: 0, renderMs: 0, bridgeMs: 0 },
      });
      // The image metadata a cell result lists stays the contract's plain metadata.
      expect(capture.imageMetadata).not.toHaveProperty("ms");
      expect(capture.image).not.toHaveProperty("phases");
    }),
);

it.effect(
  "a screenshot that keeps the tree's snapshot renders nothing and keeps its refs; one that replaces it renders once and retires them",
  () =>
    Effect.gen(function* () {
      let screenshot: Record<string, unknown> = { snapshot_id: "s0000000a" };
      const { host, sent, observations } = timedHost({
        get_window_state: (args: Record<string, unknown>) => goat2WindowState(args, screenshot),
      });
      const ref = yield* bind(host);
      const tree = (yield* host.observe(call("get_accessibility_tree", {}, ref), context))
        .value as ScreenObservation;
      const apply = tree.elements.find((element) => element.name === "Apply")?.ref;
      if (!apply) throw new Error("The tree must have the Apply button");
      expect(observations.renders).toBe(1);
      yield* host.observe(call("screenshot", {}, ref), context);
      expect(observations.renders).toBe(1);
      yield* host.invoke(call("click", { elementRef: apply }, ref), context);
      expect(sent.at(-1)).toMatchObject({ tool: "click", args: { element_token: "s0000000a:1" } });
      // A replacing reply that carries tree data still reads it and renders once.
      screenshot = {
        snapshot_id: "s0000000e",
        tree_markdown: '- [0] AXWindow "Document"',
        elements: [
          { role: "AXWindow", element_index: 0, element_token: "s0000000e:0", label: "Document" },
        ],
      };
      const replaced = yield* host.observe(call("screenshot", {}, ref), context);
      expect(observations.renders).toBe(2);
      expect(replaced.imageMetadata?.observationId).not.toBe(tree.observationId);
      // The replacing reply's tree was parsed into the rendered draft, rows and text alike.
      expect(observations.inputs[1]?.draft.elements).toMatchObject([
        { role: "AXWindow", name: "Document", index: 0, driverToken: "s0000000e:0" },
      ]);
      expect(observations.inputs[1]?.draft.indexedText).toBe('- [0] AXWindow "Document"');
      expect(replaced.imageMetadata?.observationId).toBe(observations.outputs[1]?.observationId);
      const before = sent.length;
      const stale = yield* host
        .invoke(call("click", { elementRef: apply as ScreenElementRef }, ref), context)
        .pipe(Effect.result);
      expect(stale._tag === "Failure" && stale.failure.code).toBe("stale_reference");
      expect(sent).toHaveLength(before);
    }),
);

it.effect(
  "a replacing screenshot whose tree does not fit fails as tree_limit and still retires the tree's refs",
  () =>
    Effect.gen(function* () {
      let screenshot: Record<string, unknown> = { snapshot_id: "s0000000a" };
      const observations = new CountingObservations();
      observations.failOn = 2;
      const { host, sent } = timedHost(
        { get_window_state: (args: Record<string, unknown>) => goat2WindowState(args, screenshot) },
        observations,
      );
      const ref = yield* bind(host);
      const tree = (yield* host.observe(call("get_accessibility_tree", {}, ref), context))
        .value as ScreenObservation;
      screenshot = {
        snapshot_id: "s0000000e",
        tree_markdown: '- [0] AXWindow "Document"',
        elements: [
          { role: "AXWindow", element_index: 0, element_token: "s0000000e:0", label: "Document" },
        ],
      };
      const failed = yield* host.observe(call("screenshot", {}, ref), context).pipe(Effect.result);
      expect(failed._tag === "Failure" && failed.failure.code).toBe("tree_limit");
      const before = sent.length;
      const stale = yield* host
        .invoke(
          call("click", { elementRef: tree.elements[1]?.ref as ScreenElementRef }, ref),
          context,
        )
        .pipe(Effect.result);
      expect(stale._tag === "Failure" && stale.failure.code).toBe("stale_reference");
      expect(sent).toHaveLength(before);
    }),
);

it.effect(
  "at tight budgets a read renders with the whole budget and returns exactly what was rendered, with timing only when it fits",
  () =>
    Effect.gen(function* () {
      const elements = Array.from({ length: 40 }, (_, index) => ({
        role: index === 0 ? "AXWindow" : "AXButton",
        depth: index === 0 ? 0 : 1,
        element_index: index,
        element_token: "s1:" + index,
        label: index === 0 ? "Document" : "Button " + index,
        ...(index === 0 ? {} : { parent_index: 0 }),
      }));
      const tree = {
        pid: 42,
        window_id: 7,
        snapshot_id: "s1",
        elements_complete: false,
        elements,
        tree_markdown: elements
          .map(
            (e) =>
              (e.depth ? "  " : "") +
              "- [" +
              e.element_index +
              "] " +
              e.role +
              ' "' +
              e.label +
              '"',
          )
          .join("\n"),
      };
      const observations = new CountingObservations();
      const { host } = timedHost({ get_window_state: tree }, observations);
      const ref = yield* bind(host);
      const whole = (yield* host.observe(call("get_window_state", {}, ref), context))
        .value as ScreenObservation;
      const { ms: _ms, phases: _phases, ...wholePlain } = whole;
      const wholeBytes = Buffer.byteLength(JSON.stringify(wholePlain));
      let timed = 0;
      let untimed = 0;
      // From just below the whole render to past it plus timing, one byte at a time.
      for (let treeBytes = wholeBytes - 40; treeBytes <= wholeBytes + 100; treeBytes++) {
        const limits = { ...context.limits, treeBytes };
        const read = call("get_window_state", {}, ref);
        const value = (yield* host.observe(read, { ...context, limits }))
          .value as ScreenObservation;
        const rendered = observations.outputs.at(-1);
        const budget = observationReplyBudget(read, limits);
        expect(observations.inputs.at(-1)?.limits.treeBytes).toBe(budget);
        const { ms, phases, ...plain } = value;
        expect(plain).toEqual(rendered);
        expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(budget);
        if (ms === undefined) {
          expect(phases).toBeUndefined();
          untimed++;
        } else timed++;
      }
      // The sweep crosses the boundary: some reads leave timing out, the others carry it.
      expect(untimed).toBeGreaterThan(0);
      expect(timed).toBeGreaterThan(0);
    }),
);

it.effect("a screenshot leaves its timing out when it would not fit returnBytes", () =>
  Effect.gen(function* () {
    const { host, observations } = timedHost({ get_window_state: goat2WindowState });
    const ref = yield* bind(host);
    yield* host.observe(call("get_window_state", {}, ref), context);
    const roomy = yield* host.observe(call("screenshot", {}, ref), context);
    expect(roomy.value).toHaveProperty("ms");
    const plainBytes = Buffer.byteLength(JSON.stringify(roomy.imageMetadata));
    const timedBytes = Buffer.byteLength(JSON.stringify(roomy.value));
    const renders = observations.renders;
    for (const returnBytes of [plainBytes, timedBytes - 1, timedBytes]) {
      const tight = { ...context, limits: { ...context.limits, returnBytes } };
      const capture = yield* host.observe(call("screenshot", {}, ref), tight);
      if (returnBytes < timedBytes) {
        expect(capture.value).not.toHaveProperty("ms");
        expect(capture.value).toEqual(capture.imageMetadata);
      } else expect(capture.value).toMatchObject({ ...capture.imageMetadata, ms: 7 });
    }
    // Every capture kept the tree's snapshot, so none of them rendered the tree again.
    expect(observations.renders).toBe(renders);
  }),
);

it.effect("the app cell API declares the timing app observe and screenshot return", () =>
  Effect.gen(function* () {
    const { host } = timedHost({ get_window_state: goat2WindowState });
    const ref = yield* bind(host);
    const observed = (yield* host.observe(call("get_window_state", {}, ref), context))
      .value as Timed;
    const shot = (yield* host.observe(call("screenshot", {}, ref), context)).value as Timed;
    const api = screenTargetApi({ app: true, tab: false });
    const declared = /type ReadTime = \{ ms\?: number; phases\?: \{ ([^}]*) \} \}/.exec(api)?.[1];
    for (const value of [observed, shot]) {
      expect(value.ms).toBeTypeOf("number");
      expect(declared).toBe(
        Object.keys(value.phases ?? {})
          .map((key) => key + ": number")
          .join("; "),
      );
    }
    expect(api).toContain("interface Observation extends ReadTime");
    expect(api).toContain("screenshot(): Promise<ReadTime & { imageRef: string;");
  }),
);

it.effect("observe({after}) times a page of the held read with no driver or parse time", () =>
  Effect.gen(function* () {
    const elements = Array.from({ length: 80 }, (_, index) => ({
      role: index === 0 ? "AXWindow" : "AXButton",
      depth: index === 0 ? 0 : 1,
      element_index: index,
      element_token: "s1:" + index,
      label: index === 0 ? "Document" : "Button number " + index + " with a long name",
      ...(index === 0 ? {} : { parent_index: 0, actions: ["AXPress"] }),
    }));
    const big = {
      pid: 42,
      window_id: 7,
      snapshot_id: "s1",
      elements_complete: false,
      elements,
      tree_markdown: elements
        .map(
          (e) =>
            (e.depth ? "  " : "") + "- [" + e.element_index + "] " + e.role + ' "' + e.label + '"',
        )
        .join("\n"),
    };
    const { host, sent } = timedHost({ get_window_state: big });
    const ref = yield* bind(host);
    const small = { ...context, limits: { ...context.limits, treeBytes: 4096 } };
    const first = (yield* host.observe(call("get_window_state", {}, ref), small))
      .value as ScreenObservation;
    const detail = first.omitted?.find((item) => item.kind === "budget")?.detail ?? "";
    const after = Number(/observe\(\{after:(\d+)\}\)/.exec(detail)?.[1]);
    expect(Number.isSafeInteger(after)).toBe(true);
    const reads = sent.length;
    const page = (yield* host.observe(call("get_window_state", { after }, ref), small))
      .value as Timed;
    expect(sent).toHaveLength(reads);
    expect(page).toMatchObject({
      ms: 0,
      phases: { driverMs: 0, parseMs: 0, renderMs: 0, bridgeMs: 0 },
    });
  }),
);

it("timing is left out when it would not fit the read's budget", () => {
  const observations = new ScreenObservations();
  const observation = observations.renderObservation({
    draft: {
      targetRef: {
        id: "t",
        kind: "app",
        environmentId: "e",
        runId: "r",
        turnId: "u",
        generation: 1,
      },
      targetGeneration: 1,
      surfaceGeneration: 1,
      indexedText: '- [0] AXButton "Save"',
      complete: true,
      truncated: false,
      loading: false,
      elements: [{ role: "AXButton", name: "Save", index: 0, driverToken: "s:0" }],
    },
    mode: "full",
    limits: { treeBytes: 4096 },
  });
  const timing = buildObserveTiming({
    startedAt: 10,
    endedAt: 40,
    driverMs: 25,
    parseMs: 1,
    renderMs: 2,
  });
  expect(timing).toEqual({
    ms: 30,
    phases: { driverMs: 25, parseMs: 1, renderMs: 2, bridgeMs: 2 },
  });
  const exact = Buffer.byteLength(JSON.stringify(observation));
  expect(withObserveTiming(observation, timing, exact)).toBe(observation);
  expect(withObserveTiming(observation, timing, exact + 200)).toMatchObject({ ms: 30 });
});

const calcElements = [
  { role: "AXWindow", label: "Calculator", element_index: 0, element_token: "s:0" },
  { role: "AXButton", label: "All Clear", element_index: 1, element_token: "s:1", parent_index: 0 },
  {
    role: "AXStaticText",
    label: "Result",
    value: "0",
    element_index: 2,
    element_token: "s:2",
    parent_index: 0,
  },
];
const calcMarkdown = [
  '- [0] AXWindow "Calculator" [actions=[raise]]',
  '  - [1] AXButton "All Clear" [actions=[press]]',
  '  - [2] AXStaticText "Result" = "0"',
].join("\n");

it.each([
  ["a verified tree", calcMarkdown, calcElements],
  ["a non-string role", "- [0] 7", [{ role: 7, element_index: 0, element_token: "s:0" }]],
  [
    "an empty label",
    '- [0] AXButton ""',
    [{ role: "AXButton", label: "", element_index: 0, element_token: "s:0" }],
  ],
  [
    "a non-string label",
    "- [0] AXButton",
    [{ role: "AXButton", label: 5, element_index: 0, element_token: "s:0" }],
  ],
  [
    "a duplicate index",
    '- [0] AXButton "A"',
    [
      { role: "AXButton", label: "A", element_index: 0, element_token: "s:0" },
      { role: "AXButton", label: "B", element_index: 0, element_token: "s:1" },
    ],
  ],
  [
    "a head with no boundary",
    '- [0] AXButton "OK"x',
    [{ role: "AXButton", label: "OK", element_index: 0, element_token: "s:0" }],
  ],
  [
    "a number posing in a label",
    '- [0] AXButton "A\n- [1] AXButton"',
    [{ role: "AXButton", label: "A\n- [1] AXButton", element_index: 0, element_token: "s:0" }],
  ],
  ["a number with no listed element", calcMarkdown + '\n  - [9] AXButton "Ghost"', calcElements],
  [
    "a spaced label and value pair",
    '- [0] AXGroup\n  - AXStaticText "Chip"\n  - AXStaticText "Apple"',
    [{ role: "AXGroup", element_index: 0, element_token: "s:0" }],
  ],
  [
    "a spaceless label and value pair",
    '- [0] AXGroup\n  - AXStaticText"Chip"\n  - AXStaticText"Apple"',
    [{ role: "AXGroup", element_index: 0, element_token: "s:0" }],
  ],
  [
    "a custom action",
    '- [0] AXButton "Go" [actions=[name:Open\\ntarget:0x1\\nselector:open:]]',
    [{ role: "AXButton", label: "Go", element_index: 0, element_token: "s:0" }],
  ],
  [
    "tab indentation",
    '- [0] AXWindow "W"\n\t- [1] AXButton "B"',
    [
      { role: "AXWindow", label: "W", element_index: 0, element_token: "s:0" },
      { role: "AXButton", label: "B", element_index: 1, element_token: "s:1", parent_index: 0 },
    ],
  ],
] as const)(
  "the tree text shown for %s is the same on the fast path",
  (_name, markdown, elements) => {
    const listed = elements as unknown as ReadonlyArray<Record<string, unknown>>;
    expect(fastShownTree(markdown, listed, false)).toBe(shownTree(markdown, listed));
    expect(fastShownTree(markdown, undefined, true)).toBe(shownTree(markdown));
  },
);

it.each([
  ["no unnamed element", calcMarkdown, calcElements],
  [
    "an unnamed row named by its text",
    '- [0] AXRow\n  - AXStaticText "Activity Monitor"',
    [{ role: "AXRow", element_index: 0, element_token: "s:0" }],
  ],
  [
    "a row the element list calls a group",
    '- [0] AXRow\n  - AXStaticText "Inbox"',
    [{ role: "AXGroup", element_index: 0, element_token: "s:0" }],
  ],
  [
    "an unnamed cell beside named ones",
    '- [0] AXOutlineRow\n  - AXStaticText "Docs"\n- [1] AXCell "Size"',
    [
      { role: "AXOutlineRow", element_index: 0, element_token: "s:0" },
      { role: "AXCell", label: "Size", element_index: 1, element_token: "s:1" },
    ],
  ],
] as const)(
  "rows for %s are the same whether or not the tree text is read",
  (_name, markdown, elements) => {
    const listed = elements as unknown as ReadonlyArray<Record<string, unknown>>;
    expect(desktopRows(listed, canLiftNamesFromTree(listed, markdown) ? markdown : "")).toEqual(
      desktopRows(listed, markdown),
    );
  },
);

it("an element finds its window up to 64 parent steps above it, never through a cycle", () => {
  const frame = { x: 0, y: 0, w: 10, h: 10 };
  const chain = (depth: number) => [
    { role: "AXWindow", element_index: 0, frame },
    ...Array.from({ length: depth }, (_, step) => ({
      role: "AXGroup",
      element_index: step + 1,
      parent_index: step,
      frame,
      ...(step === depth - 1 ? { element_token: "leaf" } : {}),
    })),
  ];
  expect(elementFrames(chain(64)).get("leaf")?.window).toEqual(frame);
  expect(elementFrames(chain(65)).get("leaf")?.window).toBeUndefined();
  const cycle = [
    { role: "AXGroup", element_index: 1, parent_index: 2, frame, element_token: "a" },
    { role: "AXGroup", element_index: 2, parent_index: 1, frame },
  ];
  expect(elementFrames(cycle).get("a")).toEqual({ frame });
  // Each element starts from itself; only parents are looked up by index, where the last listed wins.
  const duplicate = [
    { role: "AXWindow", element_index: 0, frame },
    { role: "AXGroup", element_index: 9, frame },
    { role: "AXButton", element_index: 5, parent_index: 0, frame, element_token: "first" },
    { role: "AXButton", element_index: 5, parent_index: 9, frame, element_token: "second" },
    { role: "AXButton", element_index: 6, parent_index: 5, frame, element_token: "child" },
  ];
  const placed = elementFrames(duplicate);
  expect(placed.get("first")?.window).toEqual(frame);
  expect(placed.get("second")?.window).toBeUndefined();
  expect(placed.get("child")?.window).toBeUndefined();
});

it.live(
  "a cell sees observe and screenshot timing without any change to the cell API runtime",
  () => {
    const { host } = fixture({ get_window_state: goat2WindowState });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source:
          "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
          "const o = await app.observe(); const s = await app.screenshot(); " +
          "return [typeof o.ms, typeof o.phases.driverMs, typeof s.ms, typeof s.phases.bridgeMs];",
      });
      expect(result.value).toEqual(["number", "number", "number", "number"]);
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
