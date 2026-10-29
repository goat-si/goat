import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import type { ScreenElementRef, ScreenTargetRef } from "@goat/contracts";
import {
  call,
  context,
  DriverError,
  fixture,
  goat2WindowState,
} from "./DesktopTargetHost.testkit.ts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const runCell = (host: ReturnType<typeof fixture>["host"], source: string) =>
  Effect.gen(function* () {
    const service = yield* ScreenRunService;
    const res = yield* service.runCell({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      invocation: context.invocation,
      source,
    });
    yield* service.finishTurn({
      runId: "r",
      turnId: "t",
      threadId: "thread",
      environmentId: "env",
      reason: "test",
    });
    return res;
  }).pipe(
    Effect.provide(
      ScreenRunService.layerWithRuntime({
        dispatcher: createScreenDispatchRouter({ app: host }),
        desktopHost: host,
        invocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        },
        assetResolver: () => resolveScreenRuntimeAsset("dev"),
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );

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

      const { screenshot_scale: _omitted, ...noScaleState } = finderDownscaled;
      const noScaleFix = fixture({ get_window_state: noScaleState });
      const noScaleBound = yield* noScaleFix.host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const noScaleCapture = yield* noScaleFix.host.observe(
        call("screenshot", {}, noScaleBound.value as ScreenTargetRef),
        context,
      );
      expect(noScaleCapture.imageMetadata?.backingScale).toBeUndefined();

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
          call("click", { x: "20", y: "16" }, ref),
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

      // On macOS, numeric-string coordinates (unaddressed or combined with elementRef) are refused as invalid_argument before dispatch.
      const macFix = fixture({ get_window_state: framedState });
      const macBound = yield* macFix.host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const macRef = macBound.value as ScreenTargetRef;
      const macObs = yield* macFix.host.observe(call("get_window_state", {}, macRef), context);
      const macApply = (
        macObs.value as { elements: Array<{ index: number; ref: ScreenElementRef }> }
      ).elements.find((item) => item.index === 1)!.ref;
      const macBefore = macFix.sent.length;
      for (const badMacCall of [
        call("click", { x: "20", y: "16" }, macRef),
        call("click", { elementRef: macApply, x: "20", y: "16" }, macRef),
        call("scroll", { elementRef: macApply, x: "10", y: "10", direction: "down" }, macRef),
        call("scroll", { scrollCenter: true, x: "20", y: "16", direction: "down" }, macRef),
        call("scroll", { scrollCenter: true, x: 20, y: 16, direction: "down" }, macRef),
        call(
          "drag",
          {
            fromEnd: { elementRef: macApply },
            toEnd: { x: 300, y: 120, coordinate_space: "window_points" },
            x: 10,
            y: 10,
          },
          macRef,
        ),
        call(
          "drag",
          {
            fromEnd: { elementRef: macApply },
            toEnd: { x: 300, y: 120, coordinate_space: "window_points" },
            from_x: 1,
            from_y: 2,
            to_x: 3,
            to_y: 4,
          },
          macRef,
        ),
      ]) {
        const refused = yield* macFix.host.invoke(badMacCall, context).pipe(Effect.flip);
        expect(refused).toMatchObject({ code: "invalid_argument", effectStarted: false });
      }
      expect(macFix.sent.slice(macBefore)).toEqual([]);

      // Valid mixed-endpoint drag without conflicting top-level coordinate fields succeeds as a control.
      const validMixedDrag = yield* macFix.host.invoke(
        call(
          "drag",
          {
            fromEnd: { elementRef: macApply },
            toEnd: { x: 300, y: 120, coordinate_space: "window_points" },
          },
          macRef,
        ),
        context,
      );
      expect(validMixedDrag.category).toBe("confirmed");
    }),
);

it.live(
  "T62a/T62b/T62c/T62d: screenshot keeping snapshot_id retains refs (guard), while an invalidating or failed screenshot or failed observe clears dead guest refs so named clicks re-observe",
  () =>
    Effect.gen(function* () {
      let mode: "keep" | "invalidate" | "failObserve" | "failShot" = "keep";
      let treeReads = 0;
      const { host, sent } = fixture({
        get_window_state: (args: Record<string, unknown>) => {
          if (args.include_accessibility_tree === false) {
            if (mode === "failShot") {
              return new DriverError({ status: "failed" }, "Screenshot capture failed");
            }
            if (mode === "invalidate") {
              return goat2WindowState(args, {
                snapshot_id: "s0000000b",
                invalidated_snapshot_ids: ["s0000000a"],
              });
            }
            return goat2WindowState(args, { snapshot_id: "s0000000a" });
          }
          treeReads++;
          if (mode === "failObserve" && treeReads === 2) {
            return new DriverError({ status: "failed" }, "AX walk timed out");
          }
          const sid = treeReads === 1 ? "s0000000a" : "s0000000c";
          return {
            ...framedState,
            snapshot_id: sid,
            tree_markdown: [
              '- [0] AXWindow "Editor"',
              '  - [1] AXButton "Apply" [actions=[press]]',
            ].join("\n"),
            elements: [
              {
                element_index: 0,
                element_token: `${sid}:0`,
                role: "AXWindow",
                label: "Editor",
                frame: { x: 100, y: 200, w: 500, h: 400 },
              },
              {
                element_index: 1,
                element_token: `${sid}:1`,
                role: "AXButton",
                label: "Apply",
                parent_index: 0,
                frame: { x: 140, y: 260, w: 80, h: 30 },
                actions: ["AXPress"],
              },
            ],
          };
        },
      });

      // T62a (guard): screenshot keeping snapshot_id retains refs for both number and name clicks.
      const keptRes = yield* runCell(
        host,
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
          "await app.observe(); await app.screenshot(); " +
          "const r1 = (await app.click(1)).verdict; const r2 = (await app.click('Apply')).verdict; return [r1, r2];",
      );
      expect(keptRes.value).toEqual(["confirmed", "confirmed"]);

      // T62b: screenshot returning replacement capture snapshot s0000000b (invalidating s0000000a) clears guest seen.observation.
      mode = "invalidate";
      treeReads = 0;
      sent.length = 0;
      const invRes = yield* runCell(
        host,
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
          "await app.observe(); await app.screenshot(); " +
          "let numErr = 'ok'; try { await app.click(1); } catch (e) { numErr = e.code; } " +
          "const named = (await app.click('Apply')).verdict; return { numErr, named };",
      );
      expect(invRes.value).toEqual({ numErr: "stale_reference", named: "confirmed" });
      expect(sent.find((s) => s.tool === "click")?.args).toMatchObject({
        element_token: "s0000000c:1",
      });

      // T62c: failed second observe (modern and legacy) clears seen.observation so named click re-observes.
      mode = "failObserve";
      treeReads = 0;
      const failObsRes = yield* runCell(
        host,
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
          "await app.observe(); " +
          "const err = await app.observe().then(() => 'ok', (e) => e.code); " +
          "let numErr = 'ok'; try { await app.click(1); } catch (e) { numErr = e.code; } " +
          "const named = (await app.click('Apply')).verdict; return { err, numErr, named };",
      );
      expect(failObsRes.value).toEqual({
        err: "downstream_failure",
        numErr: "stale_reference",
        named: "confirmed",
      });

      treeReads = 0;
      const failLegacyObsRes = yield* runCell(
        host,
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
          "await app.observe(); " +
          "const err = await app.observe({ mode: 'full' }).then(() => 'ok', (e) => e.code); " +
          "let numErr = 'ok'; try { await app.click(1); } catch (e) { numErr = e.code; } " +
          "const named = (await app.click('Apply')).verdict; return { err, numErr, named };",
      );
      expect(failLegacyObsRes.value).toEqual({
        err: "downstream_failure",
        numErr: "stale_reference",
        named: "confirmed",
      });

      // T62d: failed screenshot clears seen.observation so number click fails stale_reference and named click re-observes.
      mode = "failShot";
      treeReads = 0;
      const failShotRes = yield* runCell(
        host,
        "const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7}); " +
          "await app.observe(); " +
          "const err = await app.screenshot().then(() => 'ok', (e) => e.code); " +
          "let numErr = 'ok'; try { await app.click(1); } catch (e) { numErr = e.code; } " +
          "const named = (await app.click('Apply')).verdict; return { err, numErr, named };",
      );
      expect(failShotRes.value).toEqual({
        err: "downstream_failure",
        numErr: "stale_reference",
        named: "confirmed",
      });
    }),
);

it.effect(
  "T65: out-of-bounds screenshot pixels (including far edge) and window points fail pre-dispatch with pixels, scale, and window points in the message",
  () =>
    Effect.gen(function* () {
      const calcShot = {
        window_id: 7,
        pid: 42,
        snapshot_id: "s0000000a",
        elements_complete: false,
        tree_markdown: "",
        tree_format: "markdown",
        screenshot_width: 1348,
        screenshot_height: 816,
        screenshot_mime_type: "image/png",
        window_bounds: { x: 2892, y: 485, width: 674, height: 408 },
        screenshot_scale: 2,
        image: {
          mimeType: "image/png" as const,
          bytes: Buffer.from("png").toString("base64"),
          width: 1348,
          height: 816,
        },
      };
      const { host, sent } = fixture({ get_window_state: calcShot });
      const bound = yield* host.bindApp(
        call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
        context,
      );
      const ref = bound.value as ScreenTargetRef;
      const shot = yield* host.observe(call("screenshot", {}, ref), context);
      const regionId = shot.imageMetadata?.regionId ?? "";
      const before = sent.length;

      const oobHigh = yield* host
        .invoke(call("click", { x: 5000, y: 5000, regionId }, ref), context)
        .pipe(Effect.flip);
      expect(oobHigh).toMatchObject({ code: "invalid_argument", effectStarted: false });
      expect(oobHigh.nextStep).toContain("(5000, 5000) px");
      expect(oobHigh.nextStep).toContain("scale 2x");
      expect(oobHigh.nextStep).toContain("(2500.0, 2500.0) pt");
      expect(oobHigh.nextStep).toContain("1348×816 px");
      expect(oobHigh.nextStep).toContain("674×408 pt");

      const oobNeg = yield* host
        .invoke(call("click", { x: -10, y: -10, regionId }, ref), context)
        .pipe(Effect.flip);
      expect(oobNeg).toMatchObject({ code: "invalid_argument", effectStarted: false });
      expect(oobNeg.nextStep).toContain("(-10, -10) px");
      expect(oobNeg.nextStep).toContain("(-5.0, -5.0) pt");

      // Far edge (px === pixelWidth or py === pixelHeight) is outside [0, 1348) x [0, 816).
      const oobEdge = yield* host
        .invoke(call("click", { x: 1348, y: 816, regionId }, ref), context)
        .pipe(Effect.flip);
      expect(oobEdge).toMatchObject({ code: "invalid_argument", effectStarted: false });
      expect(oobEdge.nextStep).toContain("(1348, 816) px");

      // Out-of-bounds window_points also fails pre-dispatch.
      const oobWinPt = yield* host
        .invoke(call("click", { x: 675, y: 408, coordinate_space: "window_points" }, ref), context)
        .pipe(Effect.flip);
      expect(oobWinPt).toMatchObject({ code: "invalid_argument", effectStarted: false });
      expect(oobWinPt.nextStep).toContain("(675.0, 408.0) pt");
      expect(oobWinPt.nextStep).toContain("674×408 pt");

      expect(sent.slice(before)).toEqual([]);
    }),
);
