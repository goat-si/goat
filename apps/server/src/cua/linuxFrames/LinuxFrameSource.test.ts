import { assert, describe, it } from "@effect/vitest";
import {
  computerUseImageInfo,
  type DesktopCuaFrame,
  type DesktopCuaFrames,
  PREVIEW_SESSION_FRAME_LIMITS,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  BUSY_CAPTURE,
  SHARED_CAPTURE,
  UNREDIRECTED_CAPTURE,
  type X11WindowCapture,
} from "../linuxHelper/x11WindowCapture.ts";
import { encodeJpeg } from "./jpeg.ts";
import {
  type FrameIo,
  frameJpeg,
  frameSize,
  makeLinuxFrameSource,
  refusalOutcome,
} from "./LinuxFrameSource.ts";

/** Busy pixels, which compress worst: a fair test of the byte limit. */
const noise = (width: number, height: number) => {
  const rgb = new Uint8Array(width * height * 3);
  let seed = 7;
  for (let index = 0; index < rgb.length; index++) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    rgb[index] = seed & 0xff;
  }
  return rgb;
};

type Target = DesktopCuaFrames["targets"][number];
const TARGET: Target = {
  key: "desktop:control-1",
  pid: 4242,
  windowId: 0x400003,
  apps: ["org.example.App"],
  maxWidth: 480,
  intervalMs: 500,
};
const SHOT: X11WindowCapture = {
  png: new Uint8Array(),
  rgb: noise(16, 8),
  width: 16,
  height: 8,
};
const LISTING = { apps: [{ pid: TARGET.pid, bundle_id: "org.example.App", name: "App" }] };

/** A source on a Linux server whose every read answers as given, and the frames it sends. */
const sourceWith = (overrides: Partial<FrameIo>) =>
  Effect.gen(function* () {
    const io: FrameIo = {
      session: Effect.succeed(Option.some({ DISPLAY: ":7" })),
      placement: async () => "same",
      focus: async () => ({ known: true, secure: false }),
      listApps: Effect.succeed(LISTING),
      capture: async () => SHOT,
      ...overrides,
    };
    const source = yield* makeLinuxFrameSource("linux", io);
    const sent = yield* Queue.unbounded<DesktopCuaFrame>();
    yield* source.frames.pipe(
      Stream.runForEach((message) => Queue.offer(sent, message)),
      // Subscribed before any target is set, so no frame is published unheard.
      Effect.forkScoped({ startImmediately: true }),
    );
    return { source, sent };
  });

describe("Linux live frames (#1370)", () => {
  it("encodes a JPEG the contract reads back at its size, smaller at lower quality", () => {
    const rgb = noise(37, 21);
    const high = encodeJpeg(rgb, 37, 21, 90);
    const low = encodeJpeg(rgb, 37, 21, 30);
    assert.deepEqual(computerUseImageInfo(Buffer.from(high).toString("base64")), {
      mimeType: "image/jpeg",
      width: 37,
      height: 21,
    });
    assert.isBelow(low.length, high.length);
  });

  it.effect("keeps every frame within the frame limits, or sends none", () =>
    Effect.gen(function* () {
      const data = yield* frameJpeg(noise(480, 300), 480, 300);
      assert.isDefined(data);
      assert.isAtMost(
        Buffer.from(data ?? "", "base64").length,
        PREVIEW_SESSION_FRAME_LIMITS.maxBytes,
      );
      // A window is captured no wider than asked, and never scaled up.
      assert.deepEqual(frameSize(480)(1920, 1080), {
        width: 480,
        height: 270,
        windowWidth: 1920,
        windowHeight: 1080,
      });
      assert.include(frameSize(480)(300, 200), { width: 300, height: 200 });
    }),
  );

  it("tells a viewer why there is no picture, and says nothing for a capture that clears by itself", () => {
    assert.deepEqual(refusalOutcome(BUSY_CAPTURE, true), { skip: true });
    assert.deepEqual(refusalOutcome(SHARED_CAPTURE, false), { unavailable: "captureFailed" });
    assert.deepEqual(refusalOutcome(UNREDIRECTED_CAPTURE, false), { unavailable: "unsupported" });
  });

  it.effect("sends a frame for the seq and window it was asked for when every check passes", () =>
    Effect.gen(function* () {
      const { source, sent } = yield* sourceWith({});
      yield* source.setTargets(3, [TARGET]);
      const message = yield* Queue.take(sent);
      assert.include(message, { type: "cuaFrame", seq: 3, key: TARGET.key, width: 16 });
    }),
  );

  it.effect("sends no pixels when a check cannot be passed, and never reads the window", () =>
    Effect.gen(function* () {
      for (const [overrides, reason] of [
        [{ placement: async () => "unknown" as const }, "captureFailed"],
        [{ placement: async () => "other" as const }, "windowGone"],
        [{ focus: async () => ({ known: false, secure: false }) }, "private"],
        [{ focus: async () => ({ known: true, secure: true }) }, "private"],
        [{ listApps: Effect.succeed(undefined) }, "appNotApproved"],
        [{ session: Effect.succeedNone }, "unsupported"],
      ] as const) {
        let reads = 0;
        const { source, sent } = yield* sourceWith({
          ...overrides,
          capture: async () => {
            reads++;
            return SHOT;
          },
        });
        yield* source.setTargets(1, [TARGET]);
        const message = yield* Queue.take(sent);
        assert.deepInclude(message, { type: "cuaFrameUnavailable", reason });
        assert.strictEqual(reads, 0);
        yield* source.setTargets(2, []);
      }
    }),
  );

  it.effect("keeps a frame back when a password field gains focus while the window is read", () =>
    Effect.gen(function* () {
      let secure = false;
      const { source, sent } = yield* sourceWith({
        focus: async () => ({ known: true, secure }),
        capture: async () => {
          secure = true;
          return SHOT;
        },
      });
      yield* source.setTargets(1, [TARGET]);
      assert.deepInclude(yield* Queue.take(sent), {
        type: "cuaFrameUnavailable",
        reason: "private",
      });
    }),
  );

  it.effect("sends nothing from a capture still running when its targets are cleared", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const held = Promise.withResolvers<X11WindowCapture>();
      let calls = 0;
      const { source, sent } = yield* sourceWith({
        capture: () => {
          calls++;
          if (calls > 1) return Promise.resolve(SHOT);
          started.resolve();
          return held.promise;
        },
      });
      yield* source.setTargets(1, [TARGET]);
      yield* Effect.promise(() => started.promise);
      yield* source.setTargets(2, []);
      held.resolve(SHOT);
      // The next frame sent answers the next request; the cleared capture sent none.
      yield* source.setTargets(3, [TARGET]);
      assert.include(yield* Queue.take(sent), { type: "cuaFrame", seq: 3 });
    }),
  );
});
