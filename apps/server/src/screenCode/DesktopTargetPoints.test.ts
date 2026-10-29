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
  "window points go to the driver with coordinate_space window_points and the window's basis, report hit: null when the driver reply omits dispatch-time hit (never guessing from stale or overlapping observed frames), and surface driver hit when present",
  () =>
    Effect.gen(function* () {
      let driverHit: unknown;
      const connection = { id: "driver:1" };
      const { host, sent } = fixture(
        {
          list_windows: {
            windows: [
              {
                pid: 42,
                window_id: 7,
                title: "Document",
                bounds: { x: 100, y: 200, width: 500, height: 400 },
              },
            ],
          },
          get_window_state: framedState,
          click: () => ({
            effect: "confirmed",
            evidence: ["driver:acted"],
            ...(driverHit === undefined ? {} : { hit: driverHit }),
          }),
        },
        connection,
      );
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      yield* host.observe(call("get_window_state", {}, ref), context);
      const unhit = yield* host.invoke(
        call("click", { x: 80, y: 75, coordinate_space: "window_points" }, ref),
        context,
      );
      expect(sent.at(-1)?.args).toMatchObject({
        x: 80,
        y: 75,
        coordinate_space: "window_points",
        window_basis: { x: 100, y: 200, w: 500, h: 400 },
      });
      expect(unhit.value).toMatchObject({
        point: { x: 80, y: 75, unit: "window_points" },
        hit: null,
      });
      connection.id = "driver:2";
      const afterReplacement = yield* host.invoke(
        call("click", { x: 80, y: 75, coordinate_space: "window_points" }, ref),
        context,
      );
      expect(afterReplacement.value).toMatchObject({
        point: { x: 80, y: 75, unit: "window_points" },
        hit: null,
      });
      driverHit = { role: "AXButton", label: "Apply", element_token: "s0000000a:1" };
      const withDriverHit = yield* host.invoke(
        call("click", { x: 80, y: 75, coordinate_space: "window_points" }, ref),
        context,
      );
      expect(withDriverHit.value).toMatchObject({
        point: { x: 80, y: 75, unit: "window_points" },
        hit: { role: "AXButton", label: "Apply", element_token: "s0000000a:1" },
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
      expect(capture.imageMetadata?.scale).toBeCloseTo(1366 / 1325, 5);
      expect(capture.imageMetadata?.backingScale).toBe(2);
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
  "driver geometry and capture-registry refusal codes map to stale_reference or invalid_argument with appropriate guidance",
  () =>
    Effect.gen(function* () {
      for (const staleCode of [
        "window_geometry_changed",
        "capture_frame_mismatch",
        "capture_not_found",
        "capture_expired",
        "capture_generation_mismatch",
        "capture_target_mismatch",
      ] as const) {
        const { host } = fixture({
          get_window_state: framedState,
          click: new DriverError(
            { code: staleCode, effect: "refused", nothing_sent: true },
            `refused: ${staleCode}`,
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
      }

      for (const invalidCode of [
        "point_outside_window",
        "capture_coordinate_invalid",
        "capture_id_invalid",
      ] as const) {
        const { host } = fixture({
          get_window_state: framedState,
          click: new DriverError(
            { code: invalidCode, effect: "refused", nothing_sent: true },
            `invalid coordinate: ${invalidCode}`,
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
        expect(refused).toMatchObject({ code: "invalid_argument", effectStarted: false });
        expect(refused.nextStep).toContain(invalidCode);
      }
    }),
);

it.effect(
  "in KakaoTalk all drags are refused before dispatch, and in any app an element drag whose center overlaps a Paste menu item is refused",
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
      expect(refusedSendDrag).toMatchObject({ code: "invalid_argument", effectStarted: false });
      expect(refusedSendDrag.nextStep).toContain("Drag is unavailable in KakaoTalk");
      expect(refusedSendDrag.nextStep).not.toContain("send: true");

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

      // Element-to-element drag in KakaoTalk is also refused because drag delivers coordinate events.
      const refusedElemDragInChat = yield* host
        .invoke(
          call(
            "drag",
            { fromEnd: { elementRef: profileBtn }, toEnd: { elementRef: headerBtn }, send: true },
            ref,
          ),
          context,
        )
        .pipe(Effect.flip);
      expect(refusedElemDragInChat).toMatchObject({
        code: "invalid_argument",
        effectStarted: false,
      });
      expect(sent.slice(before)).toEqual([]);

      // In a regular app, an element drag whose endpoint center is overlapped by a Paste menu item is refused.
      const overlapState = {
        pid: 42,
        window_id: 7,
        snapshot_id: "s0000000p",
        elements_complete: false,
        tree_format: "both",
        tree_markdown:
          '[0] AXWindow "Editor"\n  [1] AXButton "Canvas"\n  [2] AXMenuItem "Paste"\n  [3] AXButton "Target"',
        elements: [
          {
            element_index: 0,
            element_token: "s0000000p:0",
            role: "AXWindow",
            label: "Editor",
            frame: { x: 0, y: 0, w: 500, h: 400 },
          },
          {
            element_index: 1,
            element_token: "s0000000p:1",
            role: "AXButton",
            label: "Canvas",
            parent_index: 0,
            frame: { x: 100, y: 100, w: 80, h: 40 },
          },
          {
            element_index: 2,
            element_token: "s0000000p:2",
            role: "AXMenuItem",
            label: "Paste",
            parent_index: 0,
            frame: { x: 120, y: 110, w: 60, h: 22 },
          },
          {
            element_index: 3,
            element_token: "s0000000p:3",
            role: "AXButton",
            label: "Target",
            parent_index: 0,
            frame: { x: 300, y: 100, w: 80, h: 40 },
          },
        ],
      };
      const editor = fixture({ get_window_state: overlapState });
      const editorBound = yield* editor.host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const editorRef = editorBound.value as ScreenTargetRef;
      const editorObs = yield* editor.host.observe(
        call("get_window_state", {}, editorRef),
        context,
      );
      const editorEls = (
        editorObs.value as { elements: Array<{ index: number; ref: ScreenElementRef }> }
      ).elements;
      const canvasBtn = editorEls.find((item) => item.index === 1)!.ref;
      const targetBtn = editorEls.find((item) => item.index === 3)!.ref;
      const editorBefore = editor.sent.length;
      const overlappedDrag = yield* editor.host
        .invoke(
          call(
            "drag",
            { fromEnd: { elementRef: canvasBtn }, toEnd: { elementRef: targetBtn } },
            editorRef,
          ),
          context,
        )
        .pipe(Effect.flip);
      expect(overlappedDrag).toMatchObject({ code: "permission_denied", effectStarted: false });
      expect(editor.sent.slice(editorBefore)).toEqual([]);
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

      // A context-free rebind + non-point input (press_key) must NOT erase the restart fence:
      // a subsequent legacy pixel click without regionId is still refused with "The driver restarted".
      // First press_key triggers the rebind (setting pointsStale = "restart"); second press_key
      // runs on the already-rebound window and must not overwrite "restart" with "input".
      yield* host.invoke(call("press_key", { key: "Escape" }, ref), context);
      yield* host.invoke(call("press_key", { key: "Escape" }, ref), context);
      const legacyAfterRestartKey = yield* host
        .invoke(call("click", { x: 10, y: 10 }, ref), context)
        .pipe(Effect.flip);
      expect(legacyAfterRestartKey.code).toBe("stale_reference");
      expect(legacyAfterRestartKey.nextStep).toContain("The driver restarted");

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
  "Linux and Windows refuse point-targeted and conflicting mixed-target actions until actuator-boundary window-basis validation exists on those platforms, while element-targeted click and scroll pass schema validation",
  () =>
    Effect.gen(function* () {
      const ELEMENT_SCROLL_KEYS = new Set([
        "session",
        "target",
        "pid",
        "window_id",
        "element_token",
        "direction",
        "by",
        "amount",
        "delivery_mode",
      ]);
      for (const platform of ["linux", "win32"] as const) {
        const platFix = fixture({
          get_window_state: (args: Record<string, unknown>) =>
            args.include_accessibility_tree === false ? goat2WindowState(args) : framedState,
          scroll: (args: Record<string, unknown>) => {
            const unknown = Object.keys(args).filter((k) => !ELEMENT_SCROLL_KEYS.has(k));
            if (unknown.length > 0)
              return new DriverError(
                { code: "invalid_arguments" },
                `unknown: ${unknown.join(",")}`,
              );
            return { effect: "confirmed", evidence: ["driver:acted"] };
          },
        });
        const host = createDesktopTargetHost({
          primitiveChannel: platFix.channel as never,
          leases: platFix.leases as never,
          platform,
        });
        const bound = yield* host.bindApp(
          call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
          context,
        );
        const ref = bound.value as ScreenTargetRef;
        const obs = yield* host.observe(call("get_window_state", {}, ref), context);
        const applyRef = (
          obs.value as { elements: Array<{ index: number; ref: ScreenElementRef }> }
        ).elements.find((item) => item.index === 1)!.ref;
        const shot = yield* host.observe(call("screenshot", {}, ref), context);
        const regionId = shot.imageMetadata?.regionId!;

        // Element-targeted click and element-targeted scroll succeed on Linux and Windows.
        const elemClick = yield* host.invoke(call("click", { elementRef: applyRef }, ref), context);
        expect(elemClick.category).toBe("confirmed");
        const elemScroll = yield* host.invoke(
          call("scroll", { elementRef: applyRef, direction: "down", amount: 3 }, ref),
          context,
        );
        expect(elemScroll.category).toBe("confirmed");
        expect(platFix.sent.at(-1)).toMatchObject({
          tool: "scroll",
          args: { element_token: "s0000000a:1", direction: "down", amount: 3 },
        });

        // Conflicting elementRef + scrollCenter or x,y is refused before dispatch with invalid_argument.
        const before = platFix.sent.length;
        for (const conflicting of [
          call(
            "scroll",
            { elementRef: applyRef, scrollCenter: true, direction: "down", amount: 3 },
            ref,
          ),
          call("scroll", { elementRef: applyRef, x: 10, y: 10, direction: "down", amount: 3 }, ref),
        ]) {
          const refused = yield* host.invoke(conflicting, context).pipe(Effect.flip);
          expect(refused).toMatchObject({ code: "invalid_argument", effectStarted: false });
        }

        // All point-targeted and unaddressed scroll actions are refused before dispatch on Linux and Windows.
        for (const unsupportedCall of [
          call("click", { x: 20, y: 16, regionId }, ref),
          call("click", { x: 20, y: 16 }, ref),
          call("click", { x: 10, y: 10, coordinate_space: "window_points" }, ref),
          call("right_click", { x: 10, y: 10, regionId }, ref),
          call("scroll", { x: 10, y: 10, regionId, direction: "down", amount: 3 }, ref),
          call("scroll", { scrollCenter: true, direction: "down", amount: 3 }, ref),
          call("scroll", { direction: "down", amount: 3 }, ref),
          call(
            "drag",
            {
              fromEnd: { elementRef: applyRef },
              toEnd: { x: 80, y: 60, regionId },
            },
            ref,
          ),
          call("type_text", { x: 10, y: 10, text: "hi", regionId }, ref),
          call("press_key", { x: 10, y: 10, key: "Return", regionId }, ref),
        ]) {
          const refused = yield* host.invoke(unsupportedCall, context).pipe(Effect.flip);
          expect(refused).toMatchObject({ code: "unsupported", effectStarted: false });
          expect(refused.nextStep).not.toContain("capture_id");
          expect(refused.nextStep).toContain("observe()");
        }
        expect(platFix.sent.slice(before)).toEqual([]);
      }
    }),
);
