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
  DriverSuccess,
  fixture,
  goat2WindowState,
  NotStarted,
} from "./DesktopTargetHost.testkit.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { ScreenRunService } from "./ScreenRunService.ts";
import { resolveScreenRuntimeAsset } from "./ScreenRuntimeAsset.ts";

const elementRead = {
  pid: 42,
  window_id: 7,
  snapshot_id: "s0000000a",
  elements_complete: false,
  tree_format: "both",
  tree_markdown: '[0] Window "Editor"\n  [1] Button "Apply"',
  elements: [
    {
      element_index: 0,
      element_token: "s0000000a:0",
      role: "Window",
      label: "Editor",
      frame: { x: 10, y: 20, w: 50, h: 40 },
    },
    {
      element_index: 1,
      element_token: "s0000000a:1",
      role: "Button",
      label: "Apply",
      parent_index: 0,
      frame: { x: 20, y: 30, w: 10, h: 5 },
    },
  ],
};
/** The window basis a Windows driver reports for a 100×80 capture of window 7. */
const basis = (overrides: Record<string, unknown> = {}) => ({
  window_id: 7,
  pid: 42,
  snapshot_id: "s0000001b",
  x: 10,
  y: 20,
  width: 50,
  height: 40,
  scale_x: 2,
  scale_y: 2,
  capture_width: 100,
  capture_height: 80,
  display_scale: 1.5,
  captured_at_ms: 1,
  ...overrides,
});
const sentAtPoint = {
  path: "pixel_basis",
  basis_checked_at_dispatch: true,
  snapshot_id: "s0000001b",
  screen_point: { x: 20, y: 28 },
  events_planned: 2,
  events_sent: 2,
  effect: "unverifiable",
};

/** A bound window on a platform whose screenshots carry what `screenshot` adds to the read. */
const boundWindow = Effect.fn(function* (
  platform: NodeJS.Platform,
  screenshot: Record<string, unknown>,
  input: Record<string, unknown> = {},
) {
  const fix = fixture(
    {
      get_window_state: (args: Record<string, unknown>) =>
        args.include_accessibility_tree === false
          ? goat2WindowState(args, { snapshot_id: "s0000000a", ...screenshot })
          : elementRead,
      click: sentAtPoint,
      right_click: sentAtPoint,
      ...input,
    },
    undefined,
    undefined,
    undefined,
    platform,
  );
  const bound = yield* fix.host.bindApp(
    call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
    context,
  );
  const ref = bound.value as ScreenTargetRef;
  const read = yield* fix.host.observe(call("get_window_state", {}, ref), context);
  const apply = (
    read.value as { elements: Array<{ index: number; ref: ScreenElementRef }> }
  ).elements.find((item) => item.index === 1)!.ref;
  const shoot = () =>
    fix.host
      .observe(call("screenshot", {}, ref), context)
      .pipe(Effect.map((shot) => shot.imageMetadata!.regionId));
  return { ...fix, ref, apply, shoot };
});

it.effect(
  "on Windows a screenshot that carries a window basis lets click and right_click send its [x, y] pixels with the basis id, and nothing GOAT would place them by",
  () =>
    Effect.gen(function* () {
      const win = yield* boundWindow("win32", { window_basis: basis() });
      const regionId = yield* win.shoot();
      const clicked = yield* win.host.invoke(
        call("click", { x: 20, y: 16, regionId, count: 2 }, win.ref),
        context,
      );
      expect(clicked.category).toBe("unverifiable");
      expect(win.sent.at(-1)).toMatchObject({
        tool: "click",
        args: {
          target: { kind: "window", pid: 42, window_id: 7 },
          x: 20,
          y: 16,
          count: 2,
          snapshot_id: "s0000001b",
        },
      });
      const args = win.sent.at(-1)!.args as Record<string, unknown>;
      for (const key of [
        "coordinate_space",
        "window_basis",
        "capture_id",
        "element_token",
        "regionId",
      ])
        expect(args).not.toHaveProperty(key);

      // Without regionId the latest screenshot's basis is used.
      yield* win.shoot();
      yield* win.host.invoke(call("right_click", { x: 99, y: 79 }, win.ref), context);
      expect(win.sent.at(-1)).toMatchObject({
        tool: "right_click",
        args: { pid: 42, window_id: 7, x: 99, y: 79, snapshot_id: "s0000001b" },
      });
    }),
);

it.effect(
  "on Windows a screenshot without a usable window basis refuses point clicks unsent, saying why",
  () =>
    Effect.gen(function* () {
      const cases = [
        [{}, "unsupported", "element number"],
        [{ basis_unavailable_reason: "no_proven_origin" }, "unsupported", "element number"],
        [
          { basis_unavailable_reason: "window_moved_during_capture" },
          "stale_reference",
          "screenshot",
        ],
        [{ basis_unavailable_reason: "capture_not_stored" }, "stale_reference", "screenshot"],
        [{ basis_unavailable_reason: "basis_retired" }, "stale_reference", "screenshot"],
        // A basis for another capture size or another window does not describe these pixels.
        [{ window_basis: basis({ capture_width: 99 }) }, "stale_reference", "screenshot"],
        [{ window_basis: basis({ window_id: 8 }) }, "stale_reference", "screenshot"],
        [{ window_basis: basis({ snapshot_id: "" }) }, "unsupported", "element number"],
      ] as const;
      for (const [screenshot, code, said] of cases) {
        const win = yield* boundWindow("win32", screenshot);
        const regionId = yield* win.shoot();
        const before = win.sent.length;
        const refused = yield* win.host
          .invoke(call("click", { x: 20, y: 16, regionId }, win.ref), context)
          .pipe(Effect.flip);
        expect(refused, JSON.stringify(screenshot)).toMatchObject({ code, effectStarted: false });
        expect(refused.nextStep).toContain(said);
        expect(win.sent.slice(before)).toEqual([]);
      }
    }),
);

it.effect(
  "on Windows the driver's basis refusals come back as what they mean, with nothing sent",
  () =>
    Effect.gen(function* () {
      const cases = [
        ["stale_basis", { reason: "window_moved" }, "stale_reference"],
        // A window whose position no capture can prove (Wayland): a new screenshot cannot help.
        ["stale_basis", { reason: "no_proven_origin" }, "unsupported"],
        ["point_outside_window", {}, "invalid_argument"],
        ["invalid_arguments", {}, "invalid_argument"],
        ["background_unavailable", {}, "unsupported"],
        ["foreground_unavailable", {}, "unavailable"],
        ["foreground_not_allowed", {}, "permission_denied"],
      ] as const;
      for (const [driverCode, extra, code] of cases) {
        const win = yield* boundWindow(
          "win32",
          { window_basis: basis() },
          {
            click: new DriverError(
              { code: driverCode, effect: "refused", nothing_sent: true, ...extra },
              `refused: ${driverCode}`,
            ),
          },
        );
        const regionId = yield* win.shoot();
        const refused = yield* win.host
          .invoke(call("click", { x: 20, y: 16, regionId }, win.ref), context)
          .pipe(Effect.flip);
        expect(refused, driverCode).toMatchObject({ code, effectStarted: false });
        if (driverCode === "stale_basis" && extra.reason === "window_moved") {
          expect(refused.nextStep).toContain("window_moved");
          expect(refused.nextStep).toContain("screenshot");
        }
        if (driverCode === "background_unavailable")
          expect(refused.refused).toBe("backgroundUnavailable");
      }
    }),
);

it.effect("on Windows a sent point click keeps the driver's warning and partial delivery", () =>
  Effect.gen(function* () {
    const warning = "foreground could not be restored: target window left in front (prior hwnd 9)";
    const win = yield* boundWindow(
      "win32",
      { window_basis: basis() },
      {
        click: new DriverSuccess({ ...sentAtPoint, warning }, "clicked"),
        right_click: {
          ...sentAtPoint,
          effect: "partial",
          code: "partial_delivery",
          events_sent: 1,
        },
      },
    );
    yield* win.shoot();
    const clicked = yield* win.host.invoke(call("click", { x: 20, y: 16 }, win.ref), context);
    expect(clicked.warnings).toContain(warning);
    const partial = yield* win.host.invoke(call("right_click", { x: 20, y: 16 }, win.ref), context);
    expect(partial.category).toBe("partial");
  }),
);

it.effect(
  "off macOS window points, point drags, point scrolls and unaddressed scrolls stay refused unsent even with a window basis, and Linux without one refuses point clicks",
  () =>
    Effect.gen(function* () {
      const win = yield* boundWindow("win32", { window_basis: basis() });
      const regionId = yield* win.shoot();
      const before = win.sent.length;
      for (const refusedCall of [
        call("click", { x: 10, y: 10, coordinate_space: "window_points" }, win.ref),
        call(
          "drag",
          { fromEnd: { elementRef: win.apply }, toEnd: { x: 80, y: 60, regionId } },
          win.ref,
        ),
        call("scroll", { x: 10, y: 10, regionId, direction: "down", amount: 3 }, win.ref),
        call("scroll", { scrollCenter: true, direction: "down", amount: 3 }, win.ref),
        call("scroll", { direction: "down", amount: 3 }, win.ref),
      ]) {
        const refused = yield* win.host.invoke(refusedCall, context).pipe(Effect.flip);
        expect(refused, JSON.stringify(refusedCall.args)).toMatchObject({
          code: "unsupported",
          effectStarted: false,
        });
        expect(refused.nextStep).toContain("observe()");
      }
      expect(win.sent.slice(before)).toEqual([]);

      // Today's Linux driver reports no window basis, so its point clicks stay refused.
      const linux = yield* boundWindow("linux", {});
      const linuxRegion = yield* linux.shoot();
      const linuxBefore = linux.sent.length;
      const refused = yield* linux.host
        .invoke(call("click", { x: 20, y: 16, regionId: linuxRegion }, linux.ref), context)
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ code: "unsupported", effectStarted: false });
      expect(linux.sent.slice(linuxBefore)).toEqual([]);
    }),
);

it.effect(
  "a point click GOAT's proxy refused because the driver's click lacks snapshot_id reads as unsupported with the proxy's words, not as an unavailable desktop",
  () =>
    Effect.gen(function* () {
      const said = "This driver cannot check a point click against its screenshot.";
      const win = yield* boundWindow(
        "win32",
        { window_basis: basis() },
        {
          click: new NotStarted(
            { refused: "outsideManifest", detail: "outside_manifest", safety: {} },
            said,
          ),
        },
      );
      yield* win.shoot();
      const refused = yield* win.host
        .invoke(call("click", { x: 20, y: 16 }, win.ref), context)
        .pipe(Effect.flip);
      expect(refused).toMatchObject({
        code: "unsupported",
        effectStarted: false,
        nextStep: said,
        detail: "outside_manifest",
      });
    }),
);

it.live(
  "on Windows one screenshot's pixels serve clicks awaited one by one and clicks started together, as on macOS",
  () => {
    const fix = fixture(
      {
        get_window_state: (args: Record<string, unknown>) =>
          args.include_accessibility_tree === false
            ? goat2WindowState(args, { snapshot_id: "s0000000a", window_basis: basis() })
            : elementRead,
        click: sentAtPoint,
      },
      undefined,
      undefined,
      undefined,
      "win32",
    );
    const turn = { runId: "r", turnId: "t", threadId: "thread", environmentId: "env" };
    return Effect.gen(function* () {
      const service = yield* ScreenRunService;
      const result = yield* service.runCell({
        ...turn,
        invocation: context.invocation,
        source: `const app = await screen.app({bundle_id: 'org.example.Editor', window_id: 7});
await app.observe();
await app.screenshot();
const one = (await app.click([20, 16])).verdict;
const two = (await app.click([30, 20])).verdict;
const together = (await Promise.allSettled([app.click([40, 20]), app.click([50, 30])])).map((r) =>
  r.status === 'fulfilled' ? r.value.verdict : r.reason.code + ':' + r.reason.nothingSent);
return [one, two, ...together];`,
      });
      yield* service.finishTurn({ ...turn, reason: "test" });
      expect(result.value).toEqual([
        "unverifiable",
        "unverifiable",
        "unverifiable",
        "unverifiable",
      ]);
      const clicks = fix.sent.filter((entry) => entry.tool === "click");
      expect(clicks.map((entry) => entry.args)).toEqual(
        [
          [20, 16],
          [30, 20],
          [40, 20],
          [50, 30],
        ].map(([x, y]) => expect.objectContaining({ x, y, snapshot_id: "s0000001b" })),
      );
    }).pipe(
      Effect.provide(
        ScreenRunService.layerWithRuntime({
          dispatcher: createScreenDispatchRouter({ app: fix.host }),
          desktopHost: fix.host,
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
