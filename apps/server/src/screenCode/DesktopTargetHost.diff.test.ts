import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";
import type { ScreenElementRef, ScreenTargetRef } from "@goat/contracts";
import { call, context, fixture, goat2WindowState } from "./DesktopTargetHost.testkit.ts";

type Observed = {
  observationId: string;
  mode: string;
  indexedText: string;
  snapshot?: string;
  elements: Array<{ name: string; ref: ScreenElementRef }>;
};
const refAt = (observed: Observed, index: number) => {
  const ref = observed.elements[index]?.ref;
  if (!ref) throw new Error(`The observation must have element ${index}`);
  return ref;
};

it.effect("desktop observations use driver diffs and refresh unchanged row tokens", () =>
  Effect.gen(function* () {
    let status = "diff";
    let reads = 0;
    const { host, sent } = fixture({
      get_window_state: (args: Record<string, unknown>) => {
        reads++;
        const snapshot = `s${reads}`;
        const old = goat2WindowState(args);
        const full = {
          ...old,
          snapshot_id: snapshot,
          elements:
            "elements" in old
              ? old.elements?.map((item) => ({
                  ...item,
                  element_token: `${snapshot}:${item.element_index}`,
                }))
              : undefined,
        };
        if (args.since === undefined) return full;
        if (status === "unknown_snapshot") return { ...full, since_status: status };
        const { tree_markdown: _tree, ...diff } = full;
        return {
          ...diff,
          since_status: status,
          tree_diff:
            status === "diff"
              ? '~ [1] AXButton "Apply"\nreindexed: [2] -> [3]\nRows and indices are as before; use snapshot_id in element_tokens (s2:N).'
              : `no change since ${args.since}. Rows and indices are as before; use snapshot_id in element_tokens (s2:N).`,
        };
      },
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
    expect(sent.at(-1)?.args).not.toHaveProperty("since");
    expect(full.snapshot).toBe("s1");
    const diff = yield* observe({ mode: "diff", baseObservationId: full.observationId });
    expect(sent.at(-1)?.args).toMatchObject({ since: "s1", tree_format: "both" });
    expect(diff).toMatchObject({
      mode: "diff",
      indexedText: `~ [1] AXButton "Apply"\nreindexed: [2] -> [3]\nother numbers unchanged since ${full.observationId}; observe({diff:false}) lists every current number`,
    });
    yield* host.invoke(call("click", { elementRef: refAt(diff, 1) }, ref), context);
    expect(sent.at(-1)).toMatchObject({ tool: "click", args: { element_token: "s2:1" } });
    status = "no_change";
    const unchanged = yield* observe({ mode: "diff", baseObservationId: diff.observationId });
    expect(unchanged).toMatchObject({
      mode: "diff",
      indexedText: `no change since ${diff.observationId}; numbers as in that observation`,
    });
    status = "unknown_snapshot";
    const before = reads;
    const fallback = yield* observe({ mode: "diff", baseObservationId: unchanged.observationId });
    expect(reads).toBe(before + 1);
    expect(fallback).toMatchObject({ mode: "full", resetReason: "full read: snapshot expired" });
    status = "no_change";
    const afterFallback = yield* observe({
      mode: "diff",
      baseObservationId: fallback.observationId,
    });
    expect(afterFallback.indexedText).toBe(
      `no change; numbers unchanged; latest full observation is ${fallback.observationId}`,
    );
    const nextCell = { ...context, cellId: "next" };
    const nextFull = (yield* host.observe(
      { ...call("get_accessibility_tree", {}, ref), cellId: "next" },
      nextCell,
    )).value as Observed;
    expect(nextFull.mode).toBe("full");
    expect(sent.at(-1)?.args).not.toHaveProperty("since");
    const nextDiff = (yield* host.observe(
      {
        ...call(
          "get_accessibility_tree",
          { mode: "diff", baseObservationId: nextFull.observationId },
          ref,
        ),
        cellId: "next",
      },
      nextCell,
    )).value as Observed;
    expect(nextDiff.indexedText).toBe(
      `no change; numbers unchanged; latest full observation is ${nextFull.observationId}`,
    );
    for (const observation of [diff, unchanged, afterFallback, nextDiff])
      expect(observation.indexedText).not.toContain("element_tokens");
    const retired = yield* host
      .invoke(call("click", { elementRef: refAt(full, 1) }, ref), context)
      .pipe(Effect.result);
    expect(retired._tag === "Failure" && retired.failure.code).toBe("stale_reference");
  }),
);

it.effect(
  "a desktop diff keeps unnumbered and multi-line rows and drops the driver's token header",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const { host } = fixture({
        get_window_state: (args: Record<string, unknown>) => {
          reads++;
          const snapshot = `s${reads}`;
          const old = goat2WindowState(args);
          const full = {
            ...old,
            snapshot_id: snapshot,
            elements:
              "elements" in old
                ? old.elements?.map((item) => ({
                    ...item,
                    element_token: `${snapshot}:${item.element_index}`,
                  }))
                : undefined,
          };
          if (args.since === undefined) return full;
          const { tree_markdown: _tree, ...diff } = full;
          return {
            ...diff,
            since_status: "diff",
            tree_diff: [
              "since s1: 0 added, 2 changed, 0 removed. Use element_tokens s2:N for + and ~ rows and unchanged rows; - ids are from s1.",
              '~ AXStaticText = "8"',
              '~ [1] AXButton "Apply" [actions=[press,name:move',
              "target:0x0]]",
            ].join("\n"),
          };
        },
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
      const diff = yield* observe({ mode: "diff", baseObservationId: full.observationId });
      expect(diff.indexedText).toBe(
        [
          '~ AXStaticText = "8"',
          '~ [1] AXButton "Apply" [actions=[press,name:move',
          "target:0x0]]",
          `other numbers unchanged; latest full observation is ${full.observationId}`,
        ].join("\n"),
      );
    }),
);

it.effect("a diff after a filtered observation reads the whole window", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      get_window_state: (args: Record<string, unknown>) => goat2WindowState(args),
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const filtered = (yield* host.observe(
      call("get_accessibility_tree", { mode: "query", query: { name: "Apply" } }, ref),
      context,
    )).value as Observed;
    const next = (yield* host.observe(
      call(
        "get_accessibility_tree",
        { mode: "diff", baseObservationId: filtered.observationId },
        ref,
      ),
      context,
    )).value as Observed;
    expect(sent.at(-1)?.args).not.toHaveProperty("since");
    expect(next).toMatchObject({ mode: "full", resetReason: "full read: scope changed" });
  }),
);

const rowState = (snapshot: string, lifted: boolean) => ({
  pid: 42,
  window_id: 7,
  snapshot_id: snapshot,
  elements_complete: false,
  tree_markdown: lifted
    ? '- [0] AXWindow "Document"\n  - [1] AXRow\n    - AXStaticText = "Target row"\n  - [2] AXButton "Target row extra"'
    : '- [0] AXWindow "Document"\n  - [1] AXRow "Before"\n  - [2] AXButton "Target row extra"',
  elements: [
    { element_index: 0, element_token: `${snapshot}:0`, role: "AXWindow", label: "Document" },
    {
      element_index: 1,
      element_token: `${snapshot}:1`,
      role: "AXRow",
      ...(lifted ? {} : { label: "Before" }),
      parent_index: 0,
    },
    {
      element_index: 2,
      element_token: `${snapshot}:2`,
      role: "AXButton",
      label: "Target row extra",
      parent_index: 0,
    },
  ],
});

it.live.each([true, false])(
  "text-named rows force a full read before resolving their name (lifted at first: %s)",
  (liftedAtFirst) => {
    let reads = 0;
    const { host, sent } = fixture({
      get_window_state: (args: Record<string, unknown>) => {
        reads++;
        const snapshot = `s${reads}`;
        if (args.since !== undefined) {
          const { tree_markdown: _markdown, ...state } = rowState(snapshot, true);
          return { ...state, since_status: "diff", tree_diff: "~ [1] AXRow" };
        }
        return rowState(snapshot, liftedAtFirst || reads > 1);
      },
    });
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        runId: "r",
        turnId: "t",
        threadId: "thread",
        environmentId: "env",
        invocation: context.invocation,
        source: `const app = await screen.app({bundle_id:'org.example.Editor', window_id:7});
          const first = await app.observe(); const second = await app.observe();
          await app.click('Target row'); return {first: first.mode, mode: second.mode, reason: second.resetReason};`,
      });
      expect(result.value).toEqual({
        first: "full",
        mode: "full",
        reason: "full read: rows named by their text",
      });
      const calls = sent.filter((entry) => entry.tool === "get_window_state");
      expect(calls).toHaveLength(liftedAtFirst ? 2 : 3);
      expect(calls[0]?.args).not.toHaveProperty("since");
      if (liftedAtFirst) expect(calls[1]?.args).not.toHaveProperty("since");
      else {
        expect(calls[1]?.args).toMatchObject({ since: "s1" });
        expect(calls[2]?.args).not.toHaveProperty("since");
      }
      expect(sent.find((entry) => entry.tool === "click")?.args).toMatchObject({
        element_token: liftedAtFirst ? "s2:1" : "s3:1",
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

it.effect("a diff after a cut read explains the cut", () =>
  Effect.gen(function* () {
    const elements = Array.from({ length: 80 }, (_, index) => ({
      role: index === 0 ? "AXWindow" : "AXButton",
      element_index: index,
      element_token: `s1:${index}`,
      label: `Button ${index} with a long name`,
    }));
    const { host, sent } = fixture({
      get_window_state: {
        pid: 42,
        window_id: 7,
        snapshot_id: "s1",
        elements_complete: false,
        elements,
        tree_markdown: elements
          .map((e) => `- [${e.element_index}] ${e.role} "${e.label}"`)
          .join("\n"),
      },
    });
    const ref = (yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    )).value as ScreenTargetRef;
    const small = { ...context, limits: { ...context.limits, treeBytes: 4096 } };
    const first = (yield* host.observe(call("get_accessibility_tree", {}, ref), small))
      .value as Observed & { truncated: boolean };
    expect(first.truncated).toBe(true);
    const next = (yield* host.observe(
      call("get_accessibility_tree", { mode: "diff", baseObservationId: first.observationId }, ref),
      small,
    )).value;
    expect(sent.at(-1)?.args).not.toHaveProperty("since");
    expect(next).toMatchObject({ mode: "full", resetReason: "full read: the last read was cut" });
  }),
);

it.effect("a driver restart retries a diff as a full read", () =>
  Effect.gen(function* () {
    const connection = { id: "driver:1" };
    const { host, sent } = fixture(
      { get_window_state: (args: Record<string, unknown>) => goat2WindowState(args) },
      connection,
    );
    const ref = (yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    )).value as ScreenTargetRef;
    const first = (yield* host.observe(call("get_accessibility_tree", {}, ref), context))
      .value as Observed;
    connection.id = "driver:2";
    yield* host.observe(
      call("get_accessibility_tree", { mode: "diff", baseObservationId: first.observationId }, ref),
      context,
    );
    expect(sent.at(-1)?.args).not.toHaveProperty("since");
  }),
);

it.live.each([
  {
    label: "unchanged",
    old: ["A", "B", "C"],
    current: ["A", "B", "C"],
    diff: '~ [1] AXButton "A"',
    clicks: [2],
    tokens: ["s2:2"],
    stale: [],
  },
  {
    label: "reindexed",
    old: ["A", "B", "C"],
    current: ["New", "A", "B", "C"],
    diff: '+ [1] AXButton "New"\nreindexed: [1-3] -> [2-4]',
    clicks: [3, 2],
    tokens: ["s2:3", "s2:2"],
    stale: [],
  },
  {
    label: "removed",
    old: ["A", "B", "C"],
    current: ["A", "B"],
    diff: '- [3] AXButton "C"',
    clicks: [3],
    tokens: [],
    stale: [3],
  },
  {
    label: "removed and reused",
    old: ["A", "B", "C"],
    current: ["A", "B", "New"],
    diff: '- [3] AXButton "C"\n+ [3] AXButton "New"',
    clicks: [3],
    tokens: ["s2:3"],
    stale: [],
  },
])("number actions follow the new snapshot for $label rows", (scenario) => {
  let reads = 0;
  const { host, sent } = fixture({
    get_window_state: (args: Record<string, unknown>) => {
      const snapshot = `s${++reads}`;
      const names = args.since === undefined ? scenario.old : scenario.current;
      const elements = ["Document", ...names].map((label, index) => ({
        element_index: index,
        element_token: `${snapshot}:${index}`,
        role: index === 0 ? "AXWindow" : "AXButton",
        label,
      }));
      return {
        pid: 42,
        window_id: 7,
        snapshot_id: snapshot,
        elements_complete: false,
        elements,
        ...(args.since === undefined
          ? {
              tree_markdown: elements
                .map((e) => `- [${e.element_index}] ${e.role} "${e.label}"`)
                .join("\n"),
            }
          : { since_status: "diff", tree_diff: scenario.diff }),
      };
    },
  });
  return Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const result = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source: `const app = await screen.app({bundle_id:'org.example.Editor', window_id:7});
        const first = await app.observe(); const second = await app.observe(); const stale = [];
        for (const n of ${JSON.stringify(scenario.clicks)}) {
          try { await app.click(n); } catch (e) { stale.push({number:n, code:e.code, nothingSent:e.nothingSent}); }
        }
        return {first, second, stale};`,
    });
    const value = result.value as {
      first: { observationId: string; mode: string };
      second: { text: string; mode: string };
      stale: unknown;
    };
    expect(value.first.mode).toBe("full");
    expect(value.second).toMatchObject({
      mode: "diff",
      text: `${scenario.diff}\n${scenario.label === "unchanged" ? `other numbers unchanged; latest full observation is ${value.first.observationId}` : `other numbers unchanged since ${value.first.observationId}; observe({diff:false}) lists every current number`}`,
    });
    expect(value.second.text).not.toContain("element_tokens");
    expect(value.stale).toEqual(
      scenario.stale.map((number) => ({ number, code: "stale_reference", nothingSent: true })),
    );
    expect(sent.filter((entry) => entry.tool === "click").map((entry) => entry.args)).toEqual(
      scenario.tokens.map((element_token) => expect.objectContaining({ element_token })),
    );
    expect(sent.filter((entry) => entry.tool === "get_window_state")[1]?.args).toMatchObject({
      since: "s1",
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

it.effect(
  "incomplete reindexing triggers one full read and preserves focus on later no-change",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const { host, sent } = fixture({
        get_window_state: (args: Record<string, unknown>) => {
          const full = { ...goat2WindowState(args), snapshot_id: `s${++reads}` };
          if (args.since === undefined) return full;
          const { tree_markdown: _tree, ...diff } = full;
          return reads === 2
            ? {
                ...diff,
                since_status: "diff",
                tree_diff:
                  "+ [1] AXButton\nreindexed: more shifted ranges not listed; pass full_output",
              }
            : {
                ...diff,
                since_status: "no_change",
                tree_diff: `no change since ${args.since}; focused element is [1]. Rows and indices are as before; use snapshot_id in element_tokens`,
              };
        },
      });
      const ref = (yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      )).value as ScreenTargetRef;
      const observe = (args: Record<string, string>) =>
        host
          .observe(call("get_accessibility_tree", args, ref), context)
          .pipe(Effect.map((result) => result.value as Observed & { resetReason?: string }));
      const first = yield* observe({});
      const fallback = yield* observe({ mode: "diff", baseObservationId: first.observationId });
      expect(reads).toBe(3);
      expect(sent.filter((entry) => entry.tool === "get_window_state")[2]?.args).not.toHaveProperty(
        "since",
      );
      expect(fallback).toMatchObject({
        mode: "full",
        resetReason: "full read: too many rows moved",
      });
      const unchanged = yield* observe({ mode: "diff", baseObservationId: fallback.observationId });
      expect(unchanged.indexedText).toBe(
        `no change; numbers unchanged; latest full observation is ${fallback.observationId}; focused element is [1]`,
      );
    }),
);
