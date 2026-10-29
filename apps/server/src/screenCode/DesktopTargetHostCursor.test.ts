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
  const read = yield* host.observe(call("get_accessibility_tree", {}, ref), context);
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

it.effect("a tree without its window places elements by the bound window's bounds", () =>
  Effect.gen(function* () {
    // macOS indexes only actionable elements, so a window without actions is not in the tree.
    const { host, sent } = fixture({
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
    // The bounds came with the binding: placing the cursor costs no driver call of its own.
    expect(sent.map((entry) => entry.tool)).toEqual([
      "list_apps",
      "list_windows",
      "get_window_state",
      "click",
      "click",
    ]);
  }),
);

it.effect(
  "a screenshot that finds the window moved drops element points until a new tree read",
  () =>
    Effect.gen(function* () {
      const read = tree([element(1, "AXButton", { frame: { x: 280, y: 130, w: 40, h: 20 } })]);
      let shownAt = 100;
      const { host, sent } = fixture({
        // The window was at x 0 when bound; it is at x 100 by the screenshot. The host cannot tell
        // whether it moved before or after the tree read, so it sends no point rather than a wrong one.
        list_windows: {
          windows: [
            {
              pid: 42,
              window_id: 7,
              title: "Document",
              bounds: { x: 0, y: 50, width: 400, height: 200 },
            },
          ],
        },
        get_window_state: (args: { include_screenshot?: boolean }) =>
          args.include_screenshot
            ? {
                pid: 42,
                window_id: 7,
                snapshot_id: "s1",
                tree_markdown: "",
                screenshot_width: 400,
                screenshot_height: 200,
                window_bounds: { x: shownAt, y: 50, width: 400, height: 200 },
                image: { mimeType: "image/png", bytes: "cG5n", width: 400, height: 200 },
              }
            : read,
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const buttonOf = (value: unknown) =>
        (value as { elements: Array<{ ref: ScreenElementRef }> }).elements[0]!.ref;
      const first = yield* host.observe(call("get_accessibility_tree", {}, ref), context);
      // The screenshot keeps the tree's snapshot, so its refs stay valid.
      yield* host.observe(call("screenshot", {}, ref), context);
      // Back where it was bound: the basis matches again, but a screenshot already showed it wrong.
      shownAt = 0;
      yield* host.observe(call("screenshot", {}, ref), context);
      yield* host.invoke(call("click", { elementRef: buttonOf(first.value) }, ref), context);
      const again = yield* host.observe(call("get_accessibility_tree", {}, ref), context);
      yield* host.invoke(call("click", { elementRef: buttonOf(again.value) }, ref), context);
      expect(
        sent.filter((entry) => entry.tool === "click").map((entry) => entry.cursor?.point),
      ).toEqual([undefined, { fx: 0.75, fy: 0.45 }]);
    }),
);

it.effect("uses the active cursor generation supplied for a switched desktop target", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      get_window_state: tree([
        element(0, "Window", { frame: { x: 100, y: 50, w: 400, h: 200 } }),
        element(1, "AXButton", { parent_index: 0, frame: { x: 280, y: 130, w: 40, h: 20 } }),
      ]),
    });
    host.setCursorGeneration?.(() => 3);
    const clicks = yield* clickEach(host, sent, [1]);
    const owner = clicks[0]?.cursor?.owner as { generation: number } | undefined;
    expect(owner?.generation).toBe(3);
  }),
);
