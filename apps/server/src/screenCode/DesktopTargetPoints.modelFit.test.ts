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
