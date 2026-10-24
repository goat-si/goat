// @effect-diagnostics nodeBuiltinImport:off

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { nextCuaWatch, requireDesktopTelemetryWriteProgress } from "./DesktopTelemetryReceiver.ts";

describe("DesktopTelemetryReceiver", () => {
  it.effect("models a zero-byte control write as a stalled descriptor", () =>
    Effect.gen(function* () {
      const error = yield* requireDesktopTelemetryWriteProgress(7, 42, 0).pipe(Effect.flip);

      expect(error._tag).toBe("DesktopTelemetryControlStalled");
      expect(error.fd).toBe(7);
      expect(error.remainingBytes).toBe(42);
      expect(error.message).toBe(
        "Desktop telemetry control stalled on fd 7 with 42 bytes remaining.",
      );
      yield* requireDesktopTelemetryWriteProgress(7, 42, 1);
    }),
  );

  it("numbers each watch change so the desktop can drop one that arrives late", () => {
    const first = nextCuaWatch({ seq: 0, active: false }, false);
    // The first decision is sent even when it is "not watching".
    expect(first).toEqual({ seq: 1, active: false });
    expect(nextCuaWatch(first, false)).toBe(first);
    const on = nextCuaWatch(first, true);
    expect(on).toEqual({ seq: 2, active: true });
    expect(nextCuaWatch(on, false)).toEqual({ seq: 3, active: false });
  });
});
