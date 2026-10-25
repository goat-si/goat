import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  linuxScreenshotPolicy,
  proxyCaptureRoute,
  SCREENSHOT_FILE_REFUSED,
  UNVERIFIED_IMAGE,
} from "./ComputerUseLinuxScreenshots.ts";
import { CROPPED_CAPTURE, type CaptureRoute } from "./linuxHelper/windowCapture.ts";
import { STILL_DRAWING, type X11WindowCapture } from "./linuxHelper/x11WindowCapture.ts";

const DRIVER_PNG = Buffer.from("driver pixels").toString("base64");
const OWN_PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const SHOT = {
  screenshot_width: 400,
  screenshot_height: 300,
  window_bounds: { width: 400, height: 300 },
};

/** A driver reply to a window read: its tree as text, its screenshot, and the structured result. */
const read = (structured: object = SHOT) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    result: {
      content: [
        { type: "text", text: "window tree" },
        { type: "image", mimeType: "image/png", data: DRIVER_PNG },
      ],
      structuredContent: { elements: [], ...structured },
    },
  });

const own = (answer: X11WindowCapture) => {
  const asked: Array<{ windowId: number; width: number }> = [];
  const route: CaptureRoute = {
    route: "own",
    capture: async (windowId, shot) => {
      asked.push({ windowId, width: shot.width });
      return answer;
    },
  };
  return { route, asked };
};

const admitted = (route: CaptureRoute, tool: string, line: string, windowId?: number) =>
  linuxScreenshotPolicy(route)
    .admit({
      tool,
      line,
      ...(windowId === undefined ? {} : { windowId }),
    })
    .pipe(
      Effect.map(
        (out) =>
          JSON.parse(out) as {
            result: {
              content: Array<Record<string, unknown>>;
              structuredContent?: Record<string, unknown>;
            };
          },
      ),
    );

describe("Linux agent screenshots (#1677)", () => {
  it.effect(
    "on X11 a window read carries GOAT's own capture of that window, never the driver's pixels",
    () =>
      Effect.gen(function* () {
        const { route, asked } = own({
          png: OWN_PNG,
          rgb: new Uint8Array(),
          width: 400,
          height: 300,
        });
        const out = yield* admitted(route, "get_window_state", read(), 9);
        assert.deepEqual(asked, [{ windowId: 9, width: 400 }]);
        assert.deepEqual(out.result.content, [
          { type: "text", text: "window tree" },
          { type: "image", mimeType: "image/png", data: Buffer.from(OWN_PNG).toString("base64") },
        ]);
        assert.equal(out.result.structuredContent?.screenshot_width, 400);
      }),
  );

  it.effect(
    "when GOAT cannot capture the window, as while the screen is locked, the image is withheld with the reason",
    () =>
      Effect.gen(function* () {
        const { route } = own({ refused: STILL_DRAWING, transient: true });
        const out = yield* admitted(route, "get_window_state", read(), 9);
        assert.deepEqual(out.result.content, [
          { type: "text", text: "window tree" },
          { type: "text", text: "GOAT withheld a screenshot from this result. " + STILL_DRAWING },
        ]);
        // Nothing says an image came with it, so the agent does not point by a missing picture.
        assert.isUndefined(out.result.structuredContent?.screenshot_width);
        assert.deepEqual(out.result.structuredContent?.elements, []);
      }),
  );

  it.effect(
    "on X11 an image from any other call, or a read naming no window, is withheld without capturing",
    () =>
      Effect.gen(function* () {
        const { route, asked } = own({
          png: OWN_PNG,
          rgb: new Uint8Array(),
          width: 400,
          height: 300,
        });
        for (const [tool, windowId] of [
          ["zoom", 9],
          ["run_steps", 9],
          ["get_window_state", undefined],
        ] as const) {
          const out = yield* admitted(route, tool, read(), windowId);
          assert.deepEqual(out.result.content[1], {
            type: "text",
            text: "GOAT withheld a screenshot from this result. " + UNVERIFIED_IMAGE,
          });
        }
        // A read whose result gives no screenshot size cannot be matched either.
        const sizeless = yield* admitted(
          route,
          "get_window_state",
          read({ screenshot_width: 0 }),
          9,
        );
        assert.equal(sizeless.result.content[1]?.type, "text");
        assert.deepEqual(asked, []);
      }),
  );

  it.effect(
    "on Wayland outside Hyprland every image is withheld; on Hyprland the driver's own export is kept",
    () =>
      Effect.gen(function* () {
        const cropped = yield* admitted(
          { route: "refused", reason: CROPPED_CAPTURE },
          "get_window_state",
          read(),
          9,
        );
        assert.deepEqual(cropped.result.content[1], {
          type: "text",
          text: "GOAT withheld a screenshot from this result. " + CROPPED_CAPTURE,
        });
        const kept = yield* linuxScreenshotPolicy({ route: "driver" }).admit({
          tool: "get_window_state",
          windowId: 9,
          line: read(),
        });
        assert.equal(kept, read());
      }),
  );

  it.effect("a reply with no image passes untouched, and nothing is captured", () =>
    Effect.gen(function* () {
      const { route, asked } = own({
        png: OWN_PNG,
        rgb: new Uint8Array(),
        width: 400,
        height: 300,
      });
      const line = JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: "clicked" }] },
      });
      assert.equal(
        yield* linuxScreenshotPolicy(route).admit({ tool: "click", windowId: 9, line }),
        line,
      );
      assert.deepEqual(asked, []);
    }),
  );

  it("the proxy captures by itself on an X display, keeps Hyprland's export, and refuses other Wayland", () => {
    assert.equal(
      proxyCaptureRoute({ x11Display: { DISPLAY: ":10" }, driverEnvironment: {} }).route,
      "own",
    );
    const hyprland = {
      CUA_DRIVER_RS_ENABLE_WAYLAND: "1",
      WAYLAND_DISPLAY: "wayland-1",
      HYPRLAND_INSTANCE_SIGNATURE: "sig",
    };
    assert.equal(
      proxyCaptureRoute({ x11Display: undefined, driverEnvironment: hyprland }).route,
      "driver",
    );
    assert.deepEqual(
      proxyCaptureRoute({
        x11Display: undefined,
        driverEnvironment: { WAYLAND_DISPLAY: "wayland-0" },
      }),
      { route: "refused", reason: CROPPED_CAPTURE },
    );
  });

  it.effect(
    "an image hidden anywhere else in a reply, nested, as a resource blob or as base64 in text, is withheld (review r1)",
    () =>
      Effect.gen(function* () {
        const { route, asked } = own({
          png: OWN_PNG,
          rgb: new Uint8Array(),
          width: 400,
          height: 300,
        });
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]).toString(
          "base64",
        );
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString("base64");
        const line = JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ frame: png }) },
              { type: "text", text: "see data:image/jpeg;base64," + jpeg },
              { type: "resource", resource: { uri: "x", mimeType: "image/png", blob: png } },
            ],
            structuredContent: { nested: { image: { type: "image", data: png } }, raw: jpeg },
          },
        });
        for (const out of [
          yield* linuxScreenshotPolicy(route).admit({ tool: "zoom", windowId: 9, line }),
          linuxScreenshotPolicy(route).scrub(line),
          linuxScreenshotPolicy({ route: "refused", reason: CROPPED_CAPTURE }).scrub(line),
        ]) {
          assert.notInclude(out, png);
          assert.notInclude(out, jpeg);
          assert.include(out, "GOAT withheld a screenshot");
        }
        assert.deepEqual(asked, []);
        // Hyprland's export is the window's own, so nothing there is touched.
        assert.equal(linuxScreenshotPolicy({ route: "driver" }).scrub(line), line);
      }),
  );

  it.effect("GOAT's capture replaces the driver's screenshot type with its own PNG", () =>
    Effect.gen(function* () {
      const { route } = own({ png: OWN_PNG, rgb: new Uint8Array(), width: 400, height: 300 });
      const out = yield* admitted(
        route,
        "get_window_state",
        read({ ...SHOT, screenshot_mime_type: "image/jpeg" }),
        9,
      );
      assert.equal(out.result.structuredContent?.screenshot_mime_type, "image/png");
      assert.equal(out.result.content[1]?.mimeType, "image/png");
    }),
  );

  it("calls that would write the driver's capture to a file are refused on every route", () => {
    for (const route of [
      own({ refused: STILL_DRAWING, transient: true }).route,
      { route: "driver" } as const,
      { route: "refused", reason: CROPPED_CAPTURE } as const,
    ]) {
      const policy = linuxScreenshotPolicy(route);
      for (const name of ["screenshot_out_file", "image_path", "file_path"])
        assert.equal(
          policy.refuseArguments({ window_id: 9, [name]: "/tmp/shot.png" }),
          SCREENSHOT_FILE_REFUSED,
        );
      assert.isUndefined(policy.refuseArguments({ window_id: 9 }));
    }
  });

  it("a Wayland backend the driver reads as off, or an X display GOAT did not place, is not trusted", () => {
    const hyprland = {
      WAYLAND_DISPLAY: "wayland-1",
      HYPRLAND_INSTANCE_SIGNATURE: "sig",
    };
    for (const off of ["0", "false", "FALSE", " 0 "])
      assert.equal(
        proxyCaptureRoute({
          x11Display: undefined,
          driverEnvironment: { ...hyprland, CUA_DRIVER_RS_ENABLE_WAYLAND: off },
        }).route,
        "refused",
      );
    assert.equal(
      proxyCaptureRoute({
        x11Display: undefined,
        driverEnvironment: { ...hyprland, CUA_DRIVER_RS_ENABLE_WAYLAND: "1", DISPLAY: ":0" },
      }).route,
      "refused",
    );
  });
});
