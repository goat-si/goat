import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ScreenObservation, ScreenTargetRef } from "@goat/contracts";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import {
  call,
  context,
  DriverError,
  fixture,
  goat2WindowState,
} from "./DesktopTargetHost.testkit.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

type Node = {
  readonly index: number;
  readonly role: string;
  readonly depth: number;
  readonly label?: string;
  readonly text?: string;
  readonly parent?: number;
  readonly actions?: ReadonlyArray<string>;
  readonly frame?: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
};

/** Activity Monitor-shaped: a large process table first, its toolbar (tabs, search, sort) last. */
const activityMonitor = (rows: number, options: { readonly headerInTable?: boolean } = {}) => {
  const nodes: Node[] = [
    { index: 0, role: "AXWindow", depth: 0, label: "Activity Monitor", actions: ["AXRaise"] },
    { index: 1, role: "AXScrollArea", depth: 1, parent: 0 },
    { index: 2, role: "AXOutline", depth: 2, parent: 1 },
  ];
  let next = 3;
  for (let row = 0; row < rows; row++) {
    const rowIndex = next++;
    // Rows below the window's 600 pt height are off screen.
    const y = 60 + row * 20;
    nodes.push({
      index: rowIndex,
      role: "AXRow",
      depth: 3,
      parent: 2,
      frame: { x: 0, y, w: 800, h: 20 },
    });
    for (const [column, words] of [`process-${row}`, `${row % 100}.5`, `${row}:01.33`].entries())
      nodes.push({
        index: next++,
        role: "AXCell",
        depth: 4,
        parent: rowIndex,
        text: words,
        frame: { x: column * 200, y, w: 200, h: 20 },
      });
  }
  // A column header with its sort button inside the outline, after the rows, as AppKit tables have.
  if (options.headerInTable) {
    const column = next++;
    nodes.push({ index: column, role: "AXColumn", depth: 3, parent: 2 });
    nodes.push({
      index: next++,
      role: "AXButton",
      depth: 4,
      parent: column,
      label: "Process Name",
      actions: ["AXPress"],
    });
  }
  const toolbar = next++;
  nodes.push({ index: toolbar, role: "AXToolbar", depth: 1, parent: 0 });
  for (const label of ["CPU", "Memory", "Energy", "Disk", "Network"])
    nodes.push({
      index: next++,
      role: "AXRadioButton",
      depth: 2,
      parent: toolbar,
      label,
      actions: ["AXPress"],
    });
  nodes.push({ index: next++, role: "AXTextField", depth: 2, parent: toolbar, label: "Search" });
  nodes.push({
    index: next++,
    role: "AXButton",
    depth: 2,
    parent: toolbar,
    label: "% CPU",
    actions: ["AXPress"],
  });
  const line = (node: Node) =>
    `${"  ".repeat(node.depth)}- [${node.index}] ${node.role}${node.label ? ` "${node.label}"` : ""}${node.text ? ` = "${node.text}"` : ""}${node.actions ? ` [actions=[${node.actions.map((each) => each.replace(/^AX/, "").toLowerCase()).join(",")}]]` : ""}`;
  return {
    pid: 42,
    window_id: 7,
    tree_markdown: nodes.map(line).join("\n"),
    elements_complete: false,
    elements: nodes.map((node) => ({
      role: node.role,
      depth: node.depth,
      element_index: node.index,
      element_token: `s1:${node.index}`,
      ...(node.label === undefined ? {} : { label: node.label }),
      ...(node.text === undefined ? {} : { label: node.text, value: node.text }),
      ...(node.parent === undefined ? {} : { parent_index: node.parent }),
      ...(node.actions === undefined ? {} : { actions: node.actions }),
      ...(node.frame === undefined ? {} : { frame: node.frame }),
    })),
  };
};

const observe = (state: ReturnType<typeof activityMonitor>) =>
  Effect.gen(function* () {
    const { host } = fixture({
      list_windows: {
        windows: [
          {
            pid: 42,
            window_id: 7,
            title: "Activity Monitor",
            bounds: { x: 0, y: 0, width: 800, height: 600 },
          },
        ],
      },
      get_window_state: state,
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    return (yield* host.observe(
      call("get_window_state", {}, bound.value as ScreenTargetRef),
      context,
    )).value as ScreenObservation;
  });

it.effect(
  "an over-budget read keeps the window's toolbar, search field and sort header before table cells",
  () =>
    Effect.gen(function* () {
      const observation = yield* observe(activityMonitor(500));
      const names = observation.elements.map((element) => element.name);
      for (const kept of ["CPU", "Memory", "Energy", "Disk", "Network", "Search", "% CPU"])
        expect(names).toContain(kept);
      expect(observation.truncated).toBe(true);
      // Cells went first; the rows they belonged to still carry their words.
      expect(observation.elements.some((element) => element.role === "AXCell")).toBe(false);
      expect(observation.indexedText).toContain("| process-0 | 0.5 | 0:01.33");
    }),
);

it.effect(
  "every element dropped for budget is reported, and no number in the text lacks its element",
  () =>
    Effect.gen(function* () {
      const observation = yield* observe(activityMonitor(1000));
      const carried = new Set(observation.elements.map((element) => element.index));
      const shown = [...observation.indexedText.matchAll(/- \[(\d+)\]/g)].map((match) =>
        Number(match[1]),
      );
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.filter((number) => !carried.has(number))).toEqual([]);
      const detail = observation.omitted?.find((item) => item.kind === "budget")?.detail ?? "";
      expect(detail).toMatch(/^Left out \d+ elements \(\[/);
      expect(detail).toContain("observe({after:");
      expect(detail.length).toBeLessThanOrEqual(200);
    }),
);

it.effect("a kept element whose container was dropped points at the nearest kept ancestor", () =>
  Effect.gen(function* () {
    const observation = yield* observe(activityMonitor(500));
    // The unnamed scroll area [1] is the first to go; its outline [2] now hangs off the window.
    expect(observation.elements.some((element) => element.index === 1)).toBe(false);
    const outline = observation.elements.find((element) => element.index === 2);
    if (outline) expect(outline.parent).toBe(0);
  }),
);

const tooLarge = {
  code: "primitive_reply_too_large",
  message: "Driver reply exceeded the primitive channel limit.",
  bytes: 2_000_000,
  maxBytes: 1_048_576,
};
type Observed = ScreenObservation & { readonly elements: ScreenObservation["elements"] };
/** The next page's start, as the omission detail names it. */
const nextPage = (observation: ScreenObservation) => {
  const detail = observation.omitted?.find((item) => item.kind === "budget")?.detail ?? "";
  const found = /observe\(\{after:(\d+)\}\)/.exec(detail);
  if (!found) throw new Error(`No next page in: ${detail}`);
  return Number(found[1]);
};
const paged = (override: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      list_windows: {
        windows: [
          {
            pid: 42,
            window_id: 7,
            title: "Activity Monitor",
            bounds: { x: 0, y: 0, width: 800, height: 600 },
          },
        ],
      },
      get_window_state: activityMonitor(500),
      ...override,
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const first = (yield* host.observe(call("get_window_state", {}, ref), context))
      .value as Observed;
    return { host, sent, ref, first };
  });

it.effect("observe after the cut reads the next part of the same read without a driver call", () =>
  Effect.gen(function* () {
    const { host, sent, ref, first } = yield* paged();
    const after = nextPage(first);
    const reads = sent.filter((entry) => entry.tool === "get_window_state").length;
    const page = (yield* host.observe(call("get_window_state", { after }, ref), context))
      .value as Observed;
    expect(sent.filter((entry) => entry.tool === "get_window_state")).toHaveLength(reads);
    expect(page.scope).toBe(`after [${after}]`);
    const carried = new Set(first.elements.map((element) => element.index));
    expect(page.elements.length).toBeGreaterThan(0);
    expect(
      page.elements.every((element) => element.index >= after && !carried.has(element.index)),
    ).toBe(true);
    expect(page.elements.some((element) => element.role === "AXCell")).toBe(true);
    // Refs from both pages still reach the driver with their tokens.
    const cpu = first.elements.find((element) => element.name === "CPU");
    const cell = page.elements.find((element) => element.role === "AXCell");
    for (const target of [cpu, cell]) {
      if (!target) throw new Error("Both pages must carry the target");
      yield* host.invoke(call("click", { elementRef: target.ref }, ref), context);
    }
    expect(
      sent
        .filter((entry) => entry.tool === "click")
        .map((entry) => (entry.args as { element_token?: string }).element_token),
    ).toEqual([`s1:${cpu?.index}`, `s1:${cell?.index}`]);
  }),
);

it.effect("pages end at the next read of the window", () =>
  Effect.gen(function* () {
    const { host, ref, first } = yield* paged();
    const after = nextPage(first);
    yield* host.observe(call("get_window_state", {}, ref), context);
    const ended = yield* host
      .observe(
        call("get_window_state", { after, baseObservationId: first.observationId }, ref),
        context,
      )
      .pipe(Effect.result);
    expect(ended._tag === "Failure" && ended.failure.code).toBe("stale_reference");
  }),
);

it.effect(
  "a window too large for one read returns its first elements with what was left out, and a screenshot keeps them",
  () =>
    Effect.gen(function* () {
      const tree = {
        pid: 42,
        window_id: 7,
        snapshot_id: "s1",
        tree_markdown: '- [0] AXWindow "Document"\n  - [1] AXButton "Apply" [actions=[press]]',
        elements_complete: false,
        elements: [
          { role: "AXWindow", element_index: 0, element_token: "s1:0", label: "Document" },
          {
            role: "AXButton",
            element_index: 1,
            element_token: "s1:1",
            label: "Apply",
            actions: ["AXPress"],
          },
        ],
      };
      const { host, sent } = fixture({
        get_window_state: (args: Record<string, unknown>) =>
          args.include_accessibility_tree === false
            ? goat2WindowState(args, { snapshot_id: "s1" })
            : Number(args.max_elements) >= 4096
              ? tooLarge
              : tree,
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const observation = (yield* host.observe(call("get_window_state", {}, ref), context))
        .value as Observed;
      expect(
        sent
          .filter((entry) => entry.tool === "get_window_state")
          .map((entry) => (entry.args as { max_elements?: number }).max_elements),
      ).toEqual([4096, 1024]);
      expect(observation.truncated).toBe(true);
      expect(observation.omitted?.find((item) => item.kind === "budget")?.detail).toBe(
        "Read stopped at 1024 elements; observe({query:{name}}) searches up to 4,096.",
      );
      yield* host.observe(call("screenshot", {}, ref), context);
      const apply = observation.elements.find((element) => element.name === "Apply");
      if (!apply) throw new Error("The fitted read must carry Apply");
      yield* host.invoke(call("click", { elementRef: apply.ref }, ref), context);
      expect(sent.at(-1)).toMatchObject({ tool: "click", args: { element_token: "s1:1" } });
    }),
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
const runCell = (source: string) =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    return yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source,
    });
  });
const PAGE =
  "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); const first = await app.observe(); " +
  "const after = Number(/after:(\\d+)/.exec(first.omitted.find((o) => o.kind === 'budget').detail)[1]); " +
  "const page = await app.observe({after}); const cells = page.elements.filter((e) => e.role === 'AXCell');";
const windowsWithBounds = {
  windows: [
    {
      pid: 42,
      window_id: 7,
      title: "Activity Monitor",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    },
  ],
};

it.live("a page's elements join the latest observation, so their numbers and names resolve", () => {
  const { host, sent } = fixture({
    list_windows: windowsWithBounds,
    get_window_state: activityMonitor(500),
    click: { effect: "unverifiable" },
  });
  return Effect.gen(function* () {
    const result = yield* runCell(
      `${PAGE} const named = cells.find((e) => e.name.startsWith('process-')); await app.click(cells[0].index); await app.click({name: named.name}); await app.click('CPU'); return [cells[0].index, named.index];`,
    );
    const [byNumber, byName] = result.value as [number, number];
    expect(
      sent
        .filter((entry) => entry.tool === "click")
        .map((entry) => (entry.args as { element_token?: string }).element_token),
    ).toEqual([`s1:${byNumber}`, `s1:${byName}`, expect.stringMatching(/^s1:\d+$/)]);
  }).pipe(Effect.provide(cellService(host)));
});

it.live(
  "page refs never go in a batch, so a read the host did not see fails before anything is sent",
  () => {
    let clicks = 0;
    const { host, sent } = fixture({
      list_windows: windowsWithBounds,
      get_window_state: activityMonitor(500),
      // Another reader (a provider-origin call) read the window after the first two clicks, so
      // the driver retired the tokens before the page refs ran.
      click: () =>
        ++clicks <= 2
          ? { effect: "confirmed", evidence: ["driver:acted"] }
          : new DriverError({
              status: "refused",
              refusal: {
                code: "stale_element_token",
                message: "element_token is stale or unknown",
              },
            }),
    });
    return Effect.gen(function* () {
      const result = yield* runCell(
        `${PAGE} await Promise.all([app.click('CPU'), app.click('Memory')]); const settled = await Promise.allSettled([app.click(cells[0].index), app.click(cells[1].index)]); const again = await app.observe({after}).then(() => 'read', (e) => e.code); return [...settled.map((s) => s.reason.code + ':' + s.reason.nothingSent), again];`,
      );
      // The first page ref goes alone and is refused; the group's next call is then not sent.
      expect(result.value).toEqual(["stale_reference:true", "not_run:true", "stale_reference"]);
      expect(sent.map((entry) => entry.tool)).toEqual([
        "list_apps",
        "list_windows",
        "get_window_state",
        "click",
        "click",
        "click",
      ]);
    }).pipe(Effect.provide(cellService(host)));
  },
);

it.effect(
  "a page ref given the first page's observation id is refused before anything is sent",
  () =>
    Effect.gen(function* () {
      const { host, sent, ref, first } = yield* paged();
      const page = (yield* host.observe(
        call("get_window_state", { after: nextPage(first) }, ref),
        context,
      )).value as Observed;
      const cell = page.elements.find((element) => element.role === "AXCell");
      if (!cell) throw new Error("The page must carry a cell");
      const before = sent.length;
      const forged = yield* host
        .invoke(
          call("click", { elementRef: { ...cell.ref, observationId: first.observationId } }, ref),
          context,
        )
        .pipe(Effect.result);
      expect(forged._tag === "Failure" && forged.failure.code).toBe("stale_reference");
      expect(sent).toHaveLength(before);
    }),
);

it.effect("an oversized read retires earlier refs even when its smaller retry fails", () =>
  Effect.gen(function* () {
    let phase = 0;
    const { host, sent } = fixture({
      get_window_state: (args: Record<string, unknown>) =>
        phase === 0
          ? activityMonitor(1)
          : Number(args.max_elements) >= 4096
            ? tooLarge
            : new DriverError({ status: "failed" }, "AX walk failed"),
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const first = (yield* host.observe(call("get_window_state", {}, ref), context))
      .value as Observed;
    phase = 1;
    const failed = yield* host
      .observe(call("get_window_state", {}, ref), context)
      .pipe(Effect.result);
    expect(failed._tag).toBe("Failure");
    const cpu = first.elements.find((element) => element.name === "CPU");
    if (!cpu) throw new Error("The first read must carry CPU");
    const before = sent.length;
    const click = yield* host
      .invoke(call("click", { elementRef: cpu.ref }, ref), context)
      .pipe(Effect.result);
    expect(click._tag === "Failure" && click.failure.code).toBe("stale_reference");
    expect(sent).toHaveLength(before);
  }),
);

it.effect("a sort header inside the table outlasts the table's cells", () =>
  Effect.gen(function* () {
    // No window bounds, so nothing is off-window and table body goes from its end.
    const { first: observation } = yield* paged({
      list_windows: { windows: [{ pid: 42, window_id: 7, title: "Activity Monitor" }] },
      get_window_state: activityMonitor(500, { headerInTable: true }),
    });
    expect(observation.truncated).toBe(true);
    expect(observation.elements.map((element) => element.name)).toContain("Process Name");
    expect(observation.elements.some((element) => element.role === "AXCell")).toBe(false);
  }),
);

it.effect(
  "T64: multi-cell Activity Monitor rows whose AXTextField cells carry actions are compacted onto the row rather than dropping the row in step 2, preserving toolbar controls",
  () =>
    Effect.gen(function* () {
      const nodes: Node[] = [
        { index: 0, role: "AXWindow", depth: 0, label: "Activity Monitor", actions: ["AXRaise"] },
        { index: 1, role: "AXScrollArea", depth: 1, parent: 0 },
        { index: 2, role: "AXOutline", depth: 2, parent: 1 },
      ];
      let next = 3;
      for (let row = 0; row < 450; row++) {
        const rowIndex = next++;
        const y = 60 + row * 20;
        nodes.push({
          index: rowIndex,
          role: "AXRow",
          depth: 3,
          parent: 2,
          frame: { x: 0, y, w: 800, h: 20 },
        });
        for (const [col, val] of [
          `process-${row}`,
          `${row % 100}.5`,
          `${row}:01.33`,
          "12",
        ].entries()) {
          nodes.push({
            index: next++,
            role: "AXTextField",
            depth: 4,
            parent: rowIndex,
            text: val,
            actions: ["AXConfirm"],
            frame: { x: col * 200, y, w: 200, h: 20 },
          });
        }
      }
      const toolbar = next++;
      nodes.push({ index: toolbar, role: "AXToolbar", depth: 1, parent: 0 });
      for (const label of ["CPU", "Memory", "Energy", "Disk", "Network"])
        nodes.push({
          index: next++,
          role: "AXRadioButton",
          depth: 2,
          parent: toolbar,
          label,
          actions: ["AXPress"],
        });
      nodes.push({
        index: next++,
        role: "AXTextField",
        depth: 2,
        parent: toolbar,
        label: "Search",
      });
      nodes.push({
        index: next++,
        role: "AXButton",
        depth: 2,
        parent: toolbar,
        label: "% CPU",
        actions: ["AXPress"],
      });
      const line = (node: Node) =>
        `${"  ".repeat(node.depth)}- [${node.index}] ${node.role}${node.label ? ` "${node.label}"` : ""}${node.text ? ` = "${node.text}"` : ""}${node.actions ? ` [actions=[${node.actions.map((each) => each.replace(/^AX/, "").toLowerCase()).join(",")}]]` : ""}`;
      const state = {
        pid: 42,
        window_id: 7,
        tree_markdown: nodes.map(line).join("\n"),
        elements_complete: false,
        elements: nodes.map((node) => ({
          role: node.role,
          depth: node.depth,
          element_index: node.index,
          element_token: `s1:${node.index}`,
          ...(node.label === undefined ? {} : { label: node.label }),
          ...(node.text === undefined ? {} : { label: node.text, value: node.text }),
          ...(node.parent === undefined ? {} : { parent_index: node.parent }),
          ...(node.actions === undefined ? {} : { actions: node.actions }),
          ...(node.frame === undefined ? {} : { frame: node.frame }),
        })),
      };
      const observation = yield* observe(state);
      const names = observation.elements.map((e) => e.name);
      for (const kept of ["CPU", "Memory", "Energy", "Disk", "Network", "Search", "% CPU"])
        expect(names).toContain(kept);
      expect(observation.truncated).toBe(true);
      expect(observation.elements.some((e) => e.role === "AXRow")).toBe(true);
      expect(
        observation.elements.some((e) => e.role === "AXTextField" && e.name !== "Search"),
      ).toBe(false);
      expect(observation.indexedText).toContain("| process-0 | 0.5 | 0:01.33 | 12");
    }),
);
