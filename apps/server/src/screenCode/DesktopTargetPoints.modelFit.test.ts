import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ScreenTargetRef } from "@goat/contracts";
import { call, context, fixture, goat2WindowState } from "./DesktopTargetHost.testkit.ts";

it.effect("a model-fit screenshot pixel click uses the delivered image dimensions", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      get_window_state: (args: Record<string, unknown>) =>
        goat2WindowState(args, {
          screenshot_width: 1195,
          screenshot_height: 768,
          screenshot_mime_type: "image/jpeg",
          window_bounds: { x: 40, y: 60, width: 1494, height: 960 },
          screenshot_scale: 2,
          image: {
            mimeType: "image/jpeg",
            bytes: Buffer.from("jpeg").toString("base64"),
            width: 1195,
            height: 768,
          },
        }),
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const capture = yield* host.observe(call("screenshot", {}, ref), context);
    expect(sent.find((entry) => entry.tool === "get_window_state")?.args).toHaveProperty(
      "screenshot_fit",
      "model",
    );
    const regionId = capture.imageMetadata?.regionId;
    if (!regionId) throw new Error("missing screenshot region");
    yield* host.invoke(call("click", { x: 598, y: 384, regionId }, ref), context);
    expect(sent.at(-1)?.args).toMatchObject({ coordinate_space: "window_points", y: 480 });
    const args = sent.at(-1)?.args;
    if (!args) throw new Error("missing click arguments");
    expect((args as { x: number }).x).toBeCloseTo((598 * 1494) / 1195, 3);
  }),
);

it.effect("each screenshot region maps clicks through its own delivered dimensions", () =>
  Effect.gen(function* () {
    let captures = 0;
    const { host, sent } = fixture({
      get_window_state: (args: Record<string, unknown>) => {
        const full = captures++ === 0;
        const width = full ? 2988 : 1195;
        const height = full ? 1920 : 768;
        return goat2WindowState(args, {
          screenshot_width: width,
          screenshot_height: height,
          screenshot_mime_type: "image/jpeg",
          window_bounds: { x: 40, y: 60, width: 1494, height: 960 },
          screenshot_scale: 2,
          image: {
            mimeType: "image/jpeg",
            bytes: Buffer.from(full ? "full" : "fit").toString("base64"),
            width,
            height,
          },
        });
      },
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const full = yield* host.observe(call("screenshot", {}, ref), context);
    const fit = yield* host.observe(call("screenshot", {}, ref), context);
    const fullRegion = full.imageMetadata?.regionId;
    const fitRegion = fit.imageMetadata?.regionId;
    if (!fullRegion || !fitRegion) throw new Error("missing screenshot regions");
    expect(fullRegion).not.toBe(fitRegion);
    yield* host.invoke(call("click", { x: 598, y: 384, regionId: fullRegion }, ref), context);
    expect(sent.at(-1)?.args).toMatchObject({ coordinate_space: "window_points", x: 299, y: 192 });
    yield* host.invoke(call("click", { x: 598, y: 384, regionId: fitRegion }, ref), context);
    const args = sent.at(-1)?.args;
    expect(args).toMatchObject({ coordinate_space: "window_points", y: 480 });
    if (!args) throw new Error("missing click arguments");
    expect((args as { x: number }).x).toBeCloseTo((598 * 1494) / 1195, 6);
    yield* host.invoke(call("click", { x: 598, y: 384 }, ref), context);
    const latest = sent.at(-1)?.args;
    expect(latest).toMatchObject({ coordinate_space: "window_points", y: 480 });
    if (!latest) throw new Error("missing latest click arguments");
    expect((latest as { x: number }).x).toBeCloseTo((598 * 1494) / 1195, 6);
    yield* host.invoke(
      call(
        "drag",
        {
          fromEnd: { x: 598, y: 384, regionId: fullRegion },
          toEnd: { x: 598, y: 384, regionId: fitRegion },
        },
        ref,
      ),
      context,
    );
    const drag = sent.at(-1)?.args;
    expect(drag).toMatchObject({
      coordinate_space: "window_points",
      from_x: 299,
      from_y: 192,
      to_y: 480,
    });
    if (!drag) throw new Error("missing drag arguments");
    expect((drag as { to_x: number }).to_x).toBeCloseTo((598 * 1494) / 1195, 6);
  }),
);

it.effect("a pixel click without a region uses the latest capture's dimensions", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      get_window_state: (args: Record<string, unknown>) =>
        goat2WindowState(args, {
          screenshot_width: 1195,
          screenshot_height: 768,
          screenshot_mime_type: "image/jpeg",
          window_bounds: { x: 40, y: 60, width: 1494, height: 960 },
          screenshot_scale: 2,
          image: {
            mimeType: "image/jpeg",
            bytes: Buffer.from("fit").toString("base64"),
            width: 1195,
            height: 768,
          },
        }),
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    yield* host.observe(call("screenshot", {}, ref), context);
    yield* host.invoke(call("click", { x: 598, y: 384 }, ref), context);
    const args = sent.at(-1)?.args;
    expect(args).toMatchObject({ coordinate_space: "window_points", y: 480 });
    if (!args) throw new Error("missing click arguments");
    expect((args as { x: number }).x).toBeCloseTo((598 * 1494) / 1195, 6);
  }),
);

it.effect("model-fit drag maps both pixel endpoints and accepts a window-point endpoint", () =>
  Effect.gen(function* () {
    const { host, sent } = fixture({
      get_window_state: (args: Record<string, unknown>) =>
        goat2WindowState(args, {
          screenshot_width: 1195,
          screenshot_height: 768,
          screenshot_mime_type: "image/jpeg",
          window_bounds: { x: 40, y: 60, width: 1494, height: 960 },
          screenshot_scale: 2,
          image: {
            mimeType: "image/jpeg",
            bytes: Buffer.from("fit").toString("base64"),
            width: 1195,
            height: 768,
          },
        }),
    });
    const bound = yield* host.bindApp(
      call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
      context,
    );
    const ref = bound.value as ScreenTargetRef;
    const shot = yield* host.observe(call("screenshot", {}, ref), context);
    const regionId = shot.imageMetadata?.regionId;
    if (!regionId) throw new Error("missing screenshot region");
    yield* host.invoke(
      call(
        "drag",
        { fromEnd: { x: 239, y: 192, regionId }, toEnd: { x: 956, y: 576, regionId } },
        ref,
      ),
      context,
    );
    expect(sent.at(-1)?.args).toMatchObject({
      coordinate_space: "window_points",
      from_x: 298.8,
      from_y: 240,
      to_x: 1195.2,
      to_y: 720,
    });
    yield* host.invoke(
      call("drag", { from_x: 239, from_y: 192, to_x: 956, to_y: 576 }, ref),
      context,
    );
    expect(sent.at(-1)?.args).toMatchObject({
      coordinate_space: "window_points",
      from_x: 298.8,
      from_y: 240,
      to_x: 1195.2,
      to_y: 720,
    });
    yield* host.invoke(
      call(
        "drag",
        {
          fromEnd: { x: 239, y: 192, regionId },
          toEnd: { x: 500, y: 300, coordinate_space: "window_points" },
        },
        ref,
      ),
      context,
    );
    expect(sent.at(-1)?.args).toMatchObject({
      coordinate_space: "window_points",
      from_x: 298.8,
      from_y: 240,
      to_x: 500,
      to_y: 300,
    });
  }),
);
