// @effect-diagnostics nodeBuiltinImport:off

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import {
  requireDesktopTelemetryWriteProgress,
  supersedesCuaReadiness,
} from "./DesktopTelemetryReceiver.ts";

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

  it("drops a readiness report from a helper launch older than the one already reported", () => {
    const report = (generation: number) =>
      ({
        version: 1,
        type: "cuaReadiness",
        generation,
        readiness: {
          grants: { accessibility: "granted", screenCapture: "granted" },
          helper: "authenticated",
          capture: "pending",
          tree: "unavailable",
          input: "unavailable",
          blockers: [],
          reasons: [],
        },
        signals: { privateMode: "unsupported", humanInput: "unsupported" },
      }) as const;
    expect(supersedesCuaReadiness(Option.none(), report(1))).toBe(true);
    expect(supersedesCuaReadiness(Option.some(report(2)), report(2))).toBe(true);
    expect(supersedesCuaReadiness(Option.some(report(2)), report(3))).toBe(true);
    expect(supersedesCuaReadiness(Option.some(report(2)), report(1))).toBe(false);
  });
});
