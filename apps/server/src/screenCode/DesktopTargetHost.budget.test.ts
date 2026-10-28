import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ScreenObservation, ScreenTargetRef } from "@goat/contracts";
import { call, context, fixture } from "./DesktopTargetHost.testkit.ts";

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
const activityMonitor = (rows: number) => {
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
