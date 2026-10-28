// @effect-diagnostics nodeBuiltinImport:off -- The regression holds the real native fd write callback.
import * as NodeFS from "node:fs";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
// @effect-diagnostics nodeBuiltinImport:off

import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, vi } from "vite-plus/test";

import {
  make,
  writeAllToFileDescriptor,
  nextCuaWatch,
  requireDesktopTelemetryWriteProgress,
  supersedesCuaReadiness,
} from "./DesktopTelemetryReceiver.ts";

vi.mock("node:fs", { spy: true });

describe("DesktopTelemetryReceiver", () => {
  it.effect("refuses an app-list request without desktop pipe descriptors", () =>
    Effect.gen(function* () {
      const receiver = yield* make();
      const error = yield* receiver.requestCuaApps("apps").pipe(Effect.flip);
      expect(error._tag).toBe("DesktopTelemetryDescriptorUnavailable");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest(),
          ServerConfig.layerTest("/test", { prefix: "goat-cua-apps" }),
        ).pipe(Layer.provide(NodeServices.layer)),
      ),
      Effect.scoped,
    ),
  );

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

  it("numbers apps-only changes and retains the apps on a retry or reconnect", () => {
    const first = nextCuaWatch({ seq: 0, active: false }, true, ["com.example.notes"]);
    expect(first).toEqual({ seq: 1, active: true, apps: ["com.example.notes"] });
    expect(nextCuaWatch(first, true, ["com.example.notes"])).toBe(first);
    const changed = nextCuaWatch(first, true, ["com.example.new", "com.example.notes"]);
    expect(changed).toEqual({
      seq: 2,
      active: true,
      apps: ["com.example.new", "com.example.notes"],
    });
    expect(
      nextCuaWatch(changed, true, ["com.example.notes", "com.example.new", "com.example.new"]),
    ).toBe(changed);
    expect(nextCuaWatch(changed, false, [])).toEqual({ seq: 3, active: false, apps: [] });
  });

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

it.effect("held native control write preserves the complete frame bytes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const parts: Buffer[] = [];
      let complete: (() => void) | undefined;
      // Production uses only the six-argument buffer overload.
      const heldWrite = <T extends NodeJS.ArrayBufferView>(
        fd: number,
        buffer: T,
        offset: number,
        length: number,
        _position: number | null,
        callback: (error: NodeJS.ErrnoException | null, count: number, buffer: T) => void,
      ) => {
        expect(fd).toBe(5);
        const count = parts.length === 0 ? Math.min(3, length) : length;
        parts.push(Buffer.from(buffer.buffer, buffer.byteOffset + offset, count));
        if (parts.length === 1) {
          complete = () => callback(null, count, buffer);
          Deferred.doneUnsafe(entered, Effect.void);
        } else callback(null, count, buffer);
      };
      using write = vi.spyOn(NodeFS, "write").mockImplementation(heldWrite as typeof NodeFS.write);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          complete?.();
          complete = undefined;
        }),
      );

      const payload = Buffer.from('{"version":1,"type":"setDiagnosticsDemand","enabled":true}\n');
      const business = yield* writeAllToFileDescriptor(5, payload).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect(write.mock.calls).toHaveLength(1);
      complete?.();
      complete = undefined;
      yield* Fiber.join(business);
      expect(Buffer.concat(parts).toString()).toBe(payload.toString());
      expect(write.mock.calls).toHaveLength(2);
    }),
  ),
);

it.effect("receiver request completes only after its held native control frame", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const completed: Buffer[] = [];
      let release: (() => void) | undefined;
      let hold = false;
      const nativeWrite = <T extends NodeJS.ArrayBufferView>(
        _fd: number,
        buffer: T,
        offset: number,
        length: number,
        _position: number | null,
        callback: (error: NodeJS.ErrnoException | null, count: number, buffer: T) => void,
      ) => {
        const finish = () => {
          completed.push(Buffer.from(buffer.buffer, buffer.byteOffset + offset, length));
          callback(null, length, buffer);
        };
        if (hold) {
          release = finish;
          Deferred.doneUnsafe(entered, Effect.void);
        } else finish();
      };
      using _write = vi
        .spyOn(NodeFS, "write")
        .mockImplementation(nativeWrite as typeof NodeFS.write);
      const config = yield* ServerConfig.ServerConfig;
      const receiver = yield* make().pipe(
        Effect.provideService(ServerConfig.ServerConfig, {
          ...config,
          desktopTelemetryControlFd: 5,
        }),
      );

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          hold = false;
          release?.();
          release = undefined;
        }),
      );
      hold = true;
      const request = yield* receiver.setDiagnosticsDemand(true).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect(request.pollUnsafe()).toBeUndefined();
      hold = false;
      release?.();
      release = undefined;
      yield* Fiber.join(request);
      expect(Buffer.concat(completed).toString()).toContain(
        '"type":"setDiagnosticsDemand","enabled":true',
      );
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest(),
        ServerConfig.layerTest("/test", { prefix: "goat-held-control" }),
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
  ),
);
