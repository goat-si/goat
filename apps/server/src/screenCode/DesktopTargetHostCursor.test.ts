import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ScreenElementRef, ScreenTargetRef } from "@goat/contracts";
import { call, context, fixture } from "./DesktopTargetHost.testkit.ts";

const element = (index: number, role: string, extra: object) => ({
  role,
  label: role,
  element_index: index,
  element_token: `s1:${index}`,
  ...extra,
});
const tree = (elements: object[]) => ({
  pid: 42,
  window_id: 7,
  snapshot_id: "s1",
  elements_complete: true,
  tree_markdown: "",
  elements,
});

/** Binds window 7, reads its tree, clicks each listed element, and returns the click requests. */
const clickEach = Effect.fn("DesktopTargetHostCursorTest.clickEach")(function* (
  host: ReturnType<typeof fixture>["host"],
  sent: ReturnType<typeof fixture>["sent"],
  indexes: readonly number[],
) {
  const bound = yield* host.bindApp(
    call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
    context,
  );
  const ref = bound.value as ScreenTargetRef;
  const read = yield* host.observe(
    { ...call("get_accessibility_tree", {}, ref), deadlineMillis: 60_000 },
    context,
  );
  const refs = (read.value as { elements: Array<{ index: number; ref: ScreenElementRef }> })
    .elements;
  for (const index of indexes)
    yield* host.invoke(
      call("click", { elementRef: refs.find((entry) => entry.index === index)!.ref }, ref),
      context,
    );
  return sent.filter((entry) => entry.tool === "click");
});

it.effect("an element click sends that element's center in its window as the cursor point", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      get_window_state: tree([
        // Windows spells the root role this way; macOS says AXWindow.
        element(0, "Window", { frame: { x: 100, y: 50, w: 400, h: 200 } }),
        element(1, "AXButton", { parent_index: 0, frame: { x: 280, y: 130, w: 40, h: 20 } }),
        element(2, "AXButton", { parent_index: 0 }),
        // A parentless menu-bar item: its root is not a window, so it gives no point.
        element(3, "AXMenuBarItem", { frame: { x: 0, y: 0, w: 80, h: 24 } }),
      ]),
    });
    const clicks = yield* clickEach(host, sent, [1, 2, 3]);
    expect(clicks.map((entry) => entry.cursor?.point)).toEqual([
      { fx: 0.5, fy: 0.45 },
      undefined,
      undefined,
    ]);
    // Every click names its owner as the target's cursor phases do, ahead of its first phase.
    const ref = clicks[0]?.cursor?.owner as { targetId: string; generation: number };
    expect(clicks.map((entry) => entry.cursor?.owner)).toEqual(
      Array(3).fill({
        environmentId: "env",
        runId: "r",
        turnId: "t",
        targetId: ref.targetId,
        generation: ref.generation,
        sequence: 0,
      }),
    );
    // The driver never sees the point: it rides beside the call for the overlay.
    expect(JSON.stringify(clicks.map((entry) => entry.args))).not.toContain("fx");
    // The tree had its window, so no extra window lookup ran.
    expect(sent.filter((entry) => entry.tool === "list_windows")).toHaveLength(1);
  }),
);

it.effect("a tree without its window places elements by the window's listed bounds", () =>
  Effect.gen(function* () {
    // macOS indexes only actionable elements, so a window without actions is not in the tree.
    const { host, sent, deadlines } = fixture({
      list_windows: {
        windows: [
          {
            pid: 42,
            window_id: 7,
            title: "Document",
            bounds: { x: 100, y: 50, width: 400, height: 200 },
          },
        ],
      },
      get_window_state: tree([
        element(1, "AXButton", { frame: { x: 280, y: 130, w: 40, h: 20 } }),
        element(3, "AXMenuBarItem", { frame: { x: 0, y: 0, w: 80, h: 24 } }),
      ]),
    });
    const clicks = yield* clickEach(host, sent, [1, 3]);
    expect(clicks.map((entry) => entry.cursor?.point)).toEqual([{ fx: 0.5, fy: 0.45 }, undefined]);
    // The lookup only places the cursor: a second of the cell's time, not all that remains.
    expect(deadlines.filter((entry) => entry.tool !== "click").slice(-2)).toEqual([
      { tool: "get_window_state", deadlineMillis: 60_000 },
      { tool: "list_windows", deadlineMillis: 1_000 },
    ]);
  }),
);
