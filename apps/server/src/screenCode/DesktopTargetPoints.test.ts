import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ScreenElementRef, ScreenTargetRef } from "@goat/contracts";
import {
  call,
  context,
  DriverError,
  fixture,
  goat2WindowState,
} from "./DesktopTargetHost.testkit.ts";

const framedState = {
  pid: 42,
  window_id: 7,
  snapshot_id: "s0000000a",
  elements_complete: false,
  tree_format: "both",
  tree_markdown: '[0] AXWindow "Editor"\n  [1] AXButton "Apply"\n  [2] AXButton "Cancel"',
  elements: [
    {
      element_index: 0,
      element_token: "s0000000a:0",
      role: "AXWindow",
      label: "Editor",
      frame: { x: 100, y: 200, w: 500, h: 400 },
    },
    {
      element_index: 1,
      element_token: "s0000000a:1",
      role: "AXButton",
      label: "Apply",
      parent_index: 0,
      frame: { x: 140, y: 260, w: 80, h: 30 },
    },
    {
      element_index: 2,
      element_token: "s0000000a:2",
      role: "AXButton",
      label: "Cancel",
      parent_index: 0,
      frame: { x: 240, y: 260, w: 80, h: 30 },
    },
  ],
};

it.effect(
  "window points go to the driver with coordinate_space window_points and the window's basis, and surface point and hit in the result",
  () =>
    Effect.gen(function* () {
      const { host, sent } = fixture({
        get_window_state: framedState,
        click: () => ({
          effect: "confirmed",
          evidence: ["driver:acted"],
          hit: { role: "AXButton", label: "Apply", element_token: "s0000000a:1" },
        }),
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      yield* host.observe(call("get_window_state", {}, ref), context);
      const clicked = yield* host.invoke(
        call("click", { x: 80, y: 75, coordinate_space: "window_points" }, ref),
        context,
      );
      expect(sent.at(-1)?.args).toMatchObject({
        x: 80,
        y: 75,
        coordinate_space: "window_points",
        window_basis: { x: 100, y: 200, w: 500, h: 400 },
      });
      expect(clicked.value).toMatchObject({
        point: { x: 80, y: 75, unit: "window_points" },
        hit: { role: "AXButton", label: "Apply", element_token: "s0000000a:1" },
      });
    }),
);

it.effect(
  "downscaled screenshot pixels map by the screenshot's region.width/pixelWidth rather than backing scale, and carry pointsPerPixel",
  () =>
    Effect.gen(function* () {
      // Finder 72907 repro: window is 1325x556 pt on a 2x Retina display, downscaled to 1366x573 px.
      const finderDownscaled = {
        window_id: 7,
        pid: 42,
        snapshot_id: "s0000000f",
        elements_complete: false,
        tree_markdown: "",
        tree_format: "markdown",
        screenshot_width: 1366,
        screenshot_height: 573,
        screenshot_mime_type: "image/png",
        window_bounds: { x: 40, y: 60, width: 1325, height: 556 },
        screenshot_scale: 2,
        image: {
          mimeType: "image/png",
          bytes: Buffer.from("png").toString("base64"),
          width: 1366,
          height: 573,
        },
      };
      const { host, sent } = fixture({ get_window_state: finderDownscaled });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const capture = yield* host.observe(call("screenshot", {}, ref), context);
      const regionId = capture.imageMetadata?.regionId;
      expect(regionId).toBeDefined();
      expect(capture.imageMetadata?.pointsPerPixel?.x).toBeCloseTo(1325 / 1366, 5);
      expect(capture.imageMetadata?.pointsPerPixel?.y).toBeCloseTo(556 / 573, 5);

      yield* host.invoke(
        call("click", { x: 90, y: 169, ...(regionId ? { regionId } : {}) }, ref),
        context,
      );
      const args = sent.at(-1)?.args as {
        x: number;
        y: number;
        coordinate_space: string;
        window_basis: { x: number; y: number; w: number; h: number };
      };
      expect(args.coordinate_space).toBe("window_points");
      expect(args.window_basis).toEqual({ x: 40, y: 60, w: 1325, h: 556 });
      expect(args.x).toBeCloseTo((90 * 1325) / 1366, 3);
      expect(args.y).toBeCloseTo((169 * 556) / 573, 3);
    }),
);

it.effect(
  "an element endpoint of a drag becomes its frame center in window points, and a moved window refuses before dispatch",
  () =>
    Effect.gen(function* () {
      let moved = false;
      const { host, sent } = fixture({
        get_window_state: (args: Record<string, unknown>) =>
          args.include_accessibility_tree === false
            ? goat2WindowState(args, {
                snapshot_id: "s0000000a",
                window_bounds: moved
                  ? { x: 250, y: 200, width: 500, height: 400 }
                  : { x: 100, y: 200, width: 500, height: 400 },
              })
            : framedState,
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const observed = yield* host.observe(call("get_window_state", {}, ref), context);
      const applyRef = (
        observed.value as { elements: Array<{ index: number; ref: ScreenElementRef }> }
      ).elements.find((item) => item.index === 1)!.ref;

      // Mixed drag: element [1] (center (180, 275) in screen -> (80, 75) in window points) to { window: [300, 120] }.
      yield* host.invoke(
        call(
          "drag",
          {
            fromEnd: { elementRef: applyRef },
            toEnd: { x: 300, y: 120, coordinate_space: "window_points" },
          },
          ref,
        ),
        context,
      );
      expect(sent.at(-1)?.args).toMatchObject({
        from_x: 80,
        from_y: 75,
        to_x: 300,
        to_y: 120,
        coordinate_space: "window_points",
        window_basis: { x: 100, y: 200, w: 500, h: 400 },
      });

      // When a screenshot shows the window moved since the tree read, element-to-point drag refuses before dispatch.
      moved = true;
      yield* host.observe(call("screenshot", {}, ref), context);
      const before = sent.length;
      const refused = yield* host
        .invoke(
          call(
            "drag",
            {
              fromEnd: { elementRef: applyRef },
              toEnd: { x: 300, y: 120, coordinate_space: "window_points" },
            },
            ref,
          ),
          context,
        )
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ code: "stale_reference", effectStarted: false });
      expect(refused.nextStep).toContain("window moved");
      expect(sent.slice(before)).toEqual([]);
    }),
);

it.effect(
  "driver window_geometry_changed surfaces as stale_reference with the window-points guidance",
  () =>
    Effect.gen(function* () {
      const { host } = fixture({
        get_window_state: framedState,
        click: new DriverError(
          {
            code: "window_geometry_changed",
            effect: "refused",
            nothing_sent: true,
          },
          "window 7 moved or resized",
        ),
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      yield* host.observe(call("get_window_state", {}, ref), context);
      const refused = yield* host
        .invoke(call("click", { x: 50, y: 50, coordinate_space: "window_points" }, ref), context)
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ code: "stale_reference", effectStarted: false });
      expect(refused.nextStep).toContain("{ window: [x, y] }");
    }),
);
