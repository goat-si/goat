import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ScreenElementRef, ScreenTargetRef } from "@goat/contracts";
import { call, context, fixture } from "./DesktopTargetHost.testkit.ts";
// Shaped like cua-driver's examples/jev-use/fixtures/native/appkit-window-state-after-actions-v1.json.
const harnessState = {
  pid: 42,
  window_id: 7,
  snapshot_id: "s00000087",
  elements_complete: true,
  tree_format: "both",
  tree_markdown:
    '- [0] AXWindow "CuaTestHarness AppKit"\n  - [1] AXButton "Increment"\n  - [2] AXButton "Reset"',
  elements: [
    {
      element_index: 0,
      element_token: "s00000087:0",
      role: "AXWindow",
      label: "CuaTestHarness AppKit",
      depth: 0,
      frame: { x: 610, y: 48, w: 700, h: 892 },
    },
    {
      element_index: 1,
      element_token: "s00000087:1",
      role: "AXButton",
      label: "Increment",
      depth: 1,
      parent_index: 0,
      actions: ["AXPress"],
      frame: { x: 629, y: 115, w: 87, h: 26 },
    },
    {
      element_index: 2,
      element_token: "s00000087:2",
      role: "AXButton",
      label: "Reset",
      depth: 1,
      parent_index: 0,
      actions: ["AXPress"],
      frame: { x: 740, y: 115, w: 70, h: 26 },
    },
  ],
};

it.effect(
  "observed app element frames are window points from the window's top-left, and a { window } click at a frame's center reaches that element",
  () =>
    Effect.gen(function* () {
      // The fake driver hit-tests what it is sent, so a hit proves where the point landed.
      const hitAt = (args: Record<string, unknown>) => {
        const basis = args.window_basis as { x: number; y: number };
        const sx = basis.x + Number(args.x);
        const sy = basis.y + Number(args.y);
        const hit = harnessState.elements.findLast(
          ({ frame }) =>
            sx >= frame.x && sx <= frame.x + frame.w && sy >= frame.y && sy <= frame.y + frame.h,
        );
        return hit === undefined ? null : { role: hit.role, label: hit.label };
      };
      const { host, sent } = fixture({
        list_windows: {
          windows: [
            {
              pid: 42,
              window_id: 7,
              title: "Harness",
              bounds: { x: 610, y: 48, width: 700, height: 892 },
            },
          ],
        },
        get_window_state: harnessState,
        click: (args: Record<string, unknown>) => ({
          effect: "confirmed",
          evidence: ["driver:acted"],
          hit: hitAt(args),
        }),
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      type Seen = {
        elements: Array<{ index: number; name: string; frame?: Frame; ref: ScreenElementRef }>;
      };
      type Frame = { x: number; y: number; width: number; height: number };
      const observed = (yield* host.observe(call("get_window_state", {}, ref), context))
        .value as Seen;
      const increment = observed.elements.find((element) => element.name === "Increment");
      expect(increment?.frame).toEqual({ x: 19, y: 67, width: 87, height: 26 });
      if (increment?.frame === undefined) throw new Error("Increment has no frame");
      const center = (frame: Frame) => ({
        x: frame.x + frame.width / 2,
        y: frame.y + frame.height / 2,
      });
      for (const name of ["Increment", "Reset"]) {
        const frame = observed.elements.find((element) => element.name === name)?.frame;
        if (frame === undefined) throw new Error(name + " has no frame");
        const point = center(frame);
        const clicked = yield* host.invoke(
          call("click", { ...point, coordinate_space: "window_points" }, ref),
          context,
        );
        expect(sent.at(-1)?.args).toMatchObject({
          ...point,
          coordinate_space: "window_points",
          window_basis: { x: 610, y: 48, w: 700, h: 892 },
        });
        expect((clicked.value as { hit?: { name?: string } }).hit?.name).toBe(name);
      }
      // The element path aims at the same point the observed frame's center names.
      yield* host.invoke(
        call(
          "drag",
          {
            fromEnd: { elementRef: increment.ref },
            toEnd: { x: 400, y: 400, coordinate_space: "window_points" },
          },
          ref,
        ),
        context,
      );
      const incrementCenter = center(increment.frame);
      expect(sent.at(-1)?.args).toMatchObject({
        from_x: incrementCenter.x,
        from_y: incrementCenter.y,
      });
      const queried = (yield* host.observe(
        call("get_window_state", { mode: "query", query: { name: "Increment" } }, ref),
        context,
      )).value as Seen;
      expect(queried.elements.find((element) => element.name === "Increment")?.frame).toEqual(
        increment.frame,
      );
    }),
);

const placedState = (elements: Array<Record<string, unknown>>) => ({
  ...harnessState,
  tree_markdown: elements
    .map(
      (entry) =>
        "- [" +
        String(entry.element_index) +
        "] " +
        String(entry.role) +
        ' "' +
        String(entry.label) +
        '"',
    )
    .join("\n"),
  elements,
});
const windowRoot = (
  index: number,
  frame?: Record<string, number>,
  token = "s00000087:" + index,
) => ({
  element_index: index,
  element_token: token,
  role: "AXWindow",
  label: "Window " + index,
  ...(frame === undefined ? {} : { frame }),
});
const child = (index: number, parent: number, x: number, token = "s00000087:" + index) => ({
  element_index: index,
  element_token: token,
  role: "AXButton",
  label: "Button " + index,
  parent_index: parent,
  frame: { x, y: 115, w: 40, h: 20 },
});
const harnessRoot = { x: 610, y: 48, w: 700, h: 892 };
const otherRoot = { x: 0, y: 0, w: 300, h: 200 };

type Observed = {
  elements: Array<{
    name: string;
    frame?: { x: number; y: number; width: number; height: number };
  }>;
  omitted?: Array<{ kind: string; detail?: string }>;
};
const observeOnce = (state: Record<string, unknown>, platform: NodeJS.Platform = "darwin") =>
  Effect.gen(function* () {
    const { host } = fixture(
      { get_window_state: state },
      undefined,
      undefined,
      undefined,
      platform,
    );
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    return (yield* host.observe(
      call("get_window_state", {}, bound.value as ScreenTargetRef),
      context,
    )).value as Observed;
  });

it.effect(
  "an element its read did not place in the bound window loses its frame, and the observation says why",
  () =>
    Effect.gen(function* () {
      const menuBar = {
        element_index: 5,
        element_token: "s00000087:5",
        role: "AXMenuBar",
        label: "Menu",
        frame: { x: 0, y: 0, w: 1440, h: 24 },
      };
      const menuItem = { ...child(6, 5, 20), label: "File" };
      const mixed = yield* observeOnce(
        placedState([windowRoot(0, harnessRoot), child(1, 0, 629), menuBar, menuItem]),
      );
      expect(mixed.elements.find((e) => e.name === "Button 1")?.frame).toEqual({
        x: 19,
        y: 67,
        width: 40,
        height: 20,
      });
      expect(mixed.elements.find((e) => e.name === "File")?.frame).toBeUndefined();
      expect(mixed.omitted).toContainEqual({
        kind: "frames",
        detail: expect.stringContaining("2 elements"),
      });

      const untrusted = {
        "no window root": [{ ...child(1, 0, 629), parent_index: undefined }],
        "two window roots": [
          windowRoot(0, harnessRoot),
          child(1, 0, 629),
          windowRoot(2, otherRoot),
          child(3, 2, 20),
        ],
        "two window roots with the same bounds": [
          windowRoot(0, harnessRoot),
          child(1, 0, 629),
          windowRoot(2, harnessRoot),
          child(3, 2, 700),
        ],
        "two window roots, other first": [
          windowRoot(2, otherRoot),
          child(3, 2, 20),
          windowRoot(0, harnessRoot),
          child(1, 0, 629),
        ],
        "a frameless second window root": [
          windowRoot(0, harnessRoot),
          child(1, 0, 629),
          windowRoot(2),
        ],
        "a frameless window root first": [
          windowRoot(2),
          windowRoot(0, harnessRoot),
          child(1, 0, 629),
        ],
        "a zero-size window root": [
          windowRoot(0, { x: 610, y: 48, w: 0, h: 892 }),
          child(1, 0, 629),
        ],
        "a repeated index": [
          windowRoot(0, harnessRoot),
          { ...menuBar, element_index: 1 },
          child(1, 0, 629, "s00000087:9"),
          child(6, 1, 20),
        ],
        "a repeated token": [
          windowRoot(0, harnessRoot),
          { ...menuBar, element_token: "s00000087:1" },
          child(1, 0, 629),
        ],
      };
      for (const [name, elements] of Object.entries(untrusted)) {
        const observed = yield* observeOnce(placedState(elements));
        expect(
          observed.elements.filter((e) => e.frame !== undefined),
          name,
        ).toEqual([]);
        expect(
          observed.omitted?.some((o) => o.kind === "frames"),
          name,
        ).toBe(true);
      }
    }),
);

it.effect("Linux element frames are window points from the AT-SPI frame that roots them", () =>
  Effect.gen(function* () {
    const observed = yield* observeOnce(
      placedState([
        { ...windowRoot(0, harnessRoot), role: "frame" },
        { ...child(1, 0, 629), role: "push button" },
      ]),
      "linux",
    );
    expect(observed.elements.find((e) => e.name === "Button 1")?.frame).toEqual({
      x: 19,
      y: 67,
      width: 40,
      height: 20,
    });
    expect(observed.omitted ?? []).not.toContainEqual(expect.objectContaining({ kind: "frames" }));
  }),
);
