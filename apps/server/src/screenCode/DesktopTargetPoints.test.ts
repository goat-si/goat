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
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";

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
  "window points go to the driver with coordinate_space window_points and the window's basis, and resolve hit from the observed element frames when the pinned goat.9 driver reply omits hit",
  () =>
    Effect.gen(function* () {
      // Pinned goat.9 click.rs reply omits structured hit; GOAT resolves hit from the observed frames.
      const { host, sent } = fixture({
        get_window_state: framedState,
        click: () => ({
          effect: "confirmed",
          evidence: ["driver:acted"],
        }),
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      yield* host.observe(call("get_window_state", {}, ref), context);
      // (80, 75) in window points is screen (180, 275), inside Apply [1] (140..220, 260..290).
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
        hit: {
          index: 1,
          role: "AXButton",
          name: "Apply",
          element_token: "s0000000a:1",
          source: "observation",
        },
      });
      // A point outside any observed element frame reports hit: null.
      const missed = yield* host.invoke(
        call("click", { x: 10, y: 10, coordinate_space: "window_points" }, ref),
        context,
      );
      expect(missed.value).toMatchObject({
        point: { x: 10, y: 10, unit: "window_points" },
        hit: null,
      });
    }),
);

it.effect(
  "downscaled screenshot pixels map by the screenshot's region.width/pixelWidth rather than backing scale, and carry pointsPerPixel",
  () =>
    Effect.gen(function* () {
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

it.effect(
  "in KakaoTalk, drag on a Send button without send: true and point drags are refused before dispatch, while a safe element drag goes through",
  () =>
    Effect.gen(function* () {
      const kakaoApps = {
        apps: [{ pid: 77, name: "KakaoTalk", bundle_id: "com.kakao.KakaoTalkMac" }],
      };
      const kakaoWindows = {
        windows: [
          {
            pid: 77,
            window_id: 81407,
            title: "김병준",
            bounds: { x: 0, y: 0, width: 500, height: 700 },
          },
        ],
      };
      const kakaoState = {
        pid: 77,
        window_id: 81407,
        snapshot_id: "s0000000k",
        elements_complete: false,
        tree_format: "both",
        tree_markdown:
          '[0] AXWindow "김병준"\n  [1] AXButton "전송"\n  [2] AXButton "Profile"\n  [3] AXButton "Header"',
        elements: [
          {
            element_index: 0,
            element_token: "s0000000k:0",
            role: "AXWindow",
            label: "김병준",
            frame: { x: 0, y: 0, w: 500, h: 700 },
          },
          {
            element_index: 1,
            element_token: "s0000000k:1",
            role: "AXButton",
            label: "전송",
            parent_index: 0,
            frame: { x: 420, y: 630, w: 60, h: 40 },
          },
          {
            element_index: 2,
            element_token: "s0000000k:2",
            role: "AXButton",
            label: "Profile",
            parent_index: 0,
            frame: { x: 20, y: 80, w: 40, h: 40 },
          },
          {
            element_index: 3,
            element_token: "s0000000k:3",
            role: "AXButton",
            label: "Header",
            parent_index: 0,
            frame: { x: 100, y: 80, w: 80, h: 40 },
          },
        ],
      };
      const { host, sent } = fixture({
        list_apps: kakaoApps,
        list_windows: kakaoWindows,
        get_window_state: kakaoState,
      });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "com.kakao.KakaoTalkMac", window_id: 81407 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const observed = yield* host.observe(call("get_window_state", {}, ref), context);
      const els = (observed.value as { elements: Array<{ index: number; ref: ScreenElementRef }> })
        .elements;
      const sendBtn = els.find((item) => item.index === 1)!.ref;
      const profileBtn = els.find((item) => item.index === 2)!.ref;
      const headerBtn = els.find((item) => item.index === 3)!.ref;
      const before = sent.length;

      // Drag touching Send button without send: true is refused.
      const refusedSendDrag = yield* host
        .invoke(
          call(
            "drag",
            { fromEnd: { elementRef: profileBtn }, toEnd: { elementRef: sendBtn } },
            ref,
          ),
          context,
        )
        .pipe(Effect.flip);
      expect(refusedSendDrag).toMatchObject({ code: "permission_denied", effectStarted: false });

      // Point drag in KakaoTalk is refused even with send: true.
      const refusedPointDrag = yield* host
        .invoke(
          call(
            "drag",
            {
              fromEnd: { elementRef: profileBtn },
              toEnd: { x: 100, y: 100, coordinate_space: "window_points" },
              send: true,
            },
            ref,
          ),
          context,
        )
        .pipe(Effect.flip);
      expect(refusedPointDrag).toMatchObject({ code: "invalid_argument", effectStarted: false });
      expect(sent.slice(before)).toEqual([]);

      // Safe element-to-element drag goes through.
      const safeDrag = yield* host.invoke(
        call(
          "drag",
          { fromEnd: { elementRef: profileBtn }, toEnd: { elementRef: headerBtn } },
          ref,
        ),
        context,
      );
      expect(safeDrag.category).toBe("confirmed");
    }),
);

it.effect(
  "after a driver replacement, screenshot-region clicks and element drags are refused instead of rebinding, and unknown or retired regionIds never fall back to a newer screenshot",
  () =>
    Effect.gen(function* () {
      const connection = { id: "driver:1" };
      const { host, sent } = fixture(
        {
          get_window_state: (args: Record<string, unknown>) =>
            args.include_accessibility_tree === false ? goat2WindowState(args) : framedState,
        },
        connection,
      );
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const observed = yield* host.observe(call("get_window_state", {}, ref), context);
      const applyRef = (
        observed.value as { elements: Array<{ index: number; ref: ScreenElementRef }> }
      ).elements.find((item) => item.index === 1)!.ref;
      const firstShot = yield* host.observe(call("screenshot", {}, ref), context);
      const oldRegionId = firstShot.imageMetadata?.regionId!;

      // Unknown regionId is refused without falling back to latestScreenshot.
      const unknownRegion = yield* host
        .invoke(call("click", { x: 10, y: 10, regionId: "region:unknown" }, ref), context)
        .pipe(Effect.flip);
      expect(unknownRegion.code).toBe("stale_reference");

      // Driver replacement: screenshot-region click and mixed element drag are refused without rebinding.
      connection.id = "driver:2";
      const before = sent.length;
      const refusedShotClick = yield* host
        .invoke(call("click", { x: 10, y: 10, regionId: oldRegionId }, ref), context)
        .pipe(Effect.flip);
      expect(refusedShotClick.code).toBe("stale_reference");
      expect(refusedShotClick.nextStep).toContain("take a new screenshot");

      const refusedElemDrag = yield* host
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
      expect(refusedElemDrag.code).toBe("stale_reference");
      expect(sent.slice(before)).toEqual([]);

      // Taking a new screenshot under driver:2 clears the restart flag for the new regionId,
      // while the retired oldRegionId from driver:1 remains refused.
      const newShot = yield* host.observe(call("screenshot", {}, ref), context);
      const newRegionId = newShot.imageMetadata?.regionId!;
      const retiredOldRegion = yield* host
        .invoke(call("click", { x: 10, y: 10, regionId: oldRegionId }, ref), context)
        .pipe(Effect.flip);
      expect(retiredOldRegion.code).toBe("stale_reference");
      const validNewRegion = yield* host.invoke(
        call("click", { x: 10, y: 10, regionId: newRegionId }, ref),
        context,
      );
      expect(validNewRegion.category).toBe("confirmed");
    }),
);

it.effect(
  "Linux and Windows keep screenshot-pixel arguments without coordinate_space or window_basis, and legacy point type_text/press_key never receive coordinate_space",
  () =>
    Effect.gen(function* () {
      const LINUX_CLICK_KEYS = new Set([
        "session",
        "target",
        "pid",
        "window_id",
        "element_token",
        "x",
        "y",
        "button",
        "count",
        "modifier",
        "action",
        "delivery_mode",
      ]);
      const KEYBOARD_KEYS = new Set([
        "session",
        "target",
        "pid",
        "window_id",
        "element_token",
        "x",
        "y",
        "text",
        "key",
        "modifiers",
        "delay_ms",
        "delivery_mode",
      ]);
      const base = fixture({
        get_window_state: (args: Record<string, unknown>) =>
          args.include_accessibility_tree === false ? goat2WindowState(args) : framedState,
        click: (args: Record<string, unknown>) => {
          const unknown = Object.keys(args).filter((k) => !LINUX_CLICK_KEYS.has(k));
          if (unknown.length > 0)
            return new DriverError({ code: "invalid_arguments" }, `unknown: ${unknown.join(",")}`);
          return { effect: "confirmed", evidence: ["driver:acted"] };
        },
        type_text: (args: Record<string, unknown>) => {
          const unknown = Object.keys(args).filter((k) => !KEYBOARD_KEYS.has(k));
          if (unknown.length > 0)
            return new DriverError({ code: "invalid_arguments" }, `unknown: ${unknown.join(",")}`);
          return { effect: "confirmed", evidence: ["driver:acted"] };
        },
        press_key: (args: Record<string, unknown>) => {
          const unknown = Object.keys(args).filter((k) => !KEYBOARD_KEYS.has(k));
          if (unknown.length > 0)
            return new DriverError({ code: "invalid_arguments" }, `unknown: ${unknown.join(",")}`);
          return { effect: "confirmed", evidence: ["driver:acted"] };
        },
      });
      for (const platform of ["linux", "win32"] as const) {
        const host = createDesktopTargetHost({
          primitiveChannel: base.channel as never,
          leases: base.leases as never,
          platform,
        });
        const bound = yield* host.bindApp(
          call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
          context,
        );
        const ref = bound.value as ScreenTargetRef;
        const shot = yield* host.observe(call("screenshot", {}, ref), context);
        const regionId = shot.imageMetadata?.regionId!;
        const clicked = yield* host.invoke(call("click", { x: 20, y: 16, regionId }, ref), context);
        expect(clicked.category).toBe("confirmed");
        expect(base.sent.at(-1)?.args).not.toHaveProperty("coordinate_space");
        expect(base.sent.at(-1)?.args).not.toHaveProperty("window_basis");
      }

      // On macOS, legacy point-targeted type_text and press_key never acquire coordinate_space or window_basis.
      const boundMac = yield* base.host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const macRef = boundMac.value as ScreenTargetRef;
      const macShot = yield* base.host.observe(call("screenshot", {}, macRef), context);
      const macRegion = macShot.imageMetadata?.regionId!;
      const typed = yield* base.host.invoke(
        call("type_text", { x: 20, y: 16, text: "hi", regionId: macRegion }, macRef),
        context,
      );
      expect(typed.category).toBe("confirmed");
      const pressed = yield* base.host.invoke(
        call("press_key", { x: 20, y: 16, key: "Return", regionId: macRegion }, macRef),
        context,
      );
      expect(pressed.category).toBe("confirmed");
    }),
);
