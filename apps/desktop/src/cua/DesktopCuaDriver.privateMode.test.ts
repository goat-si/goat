import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fixture } from "./DesktopCuaDriver.testkit.ts";

describe("DesktopCuaDriver private mode", () => {
  it.effect("does not claim private mode for a helper build that cannot watch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "darwin",
          helper: { granted: true },
          helperWithoutWatch: true,
        });
        yield* test.request("agent");
        assert.equal((yield* test.next).status, "ready");
        assert.deepEqual(test.readiness.at(-1)?.signals, {
          privateMode: "unsupported",
          humanInput: "unsupported",
        });
      }),
    ),
  );

  it.effect(
    "watches for a secret field only while agents control the host, and clears it when the helper stops",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({
            platform: "darwin",
            helper: { granted: true },
          });
          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");
          assert.deepEqual(test.readiness.at(-1)?.signals, {
            privateMode: "supported",
            humanInput: "supported",
          });

          yield* test.setWatching(true);
          assert.equal(yield* test.nextHelperWatch, "watch");
          yield* test.raisePrivateMode(true, 3);
          yield* test.nextSafety;
          yield* test.setWatching(false);
          assert.equal(yield* test.nextHelperWatch, "unwatch");
          yield* test.setWatching(true);
          assert.equal(yield* test.nextHelperWatch, "watch");

          // The helper goes away with the field still focused: the server hears it cleared.
          yield* test.restart;
          yield* test.nextSafety;
          assert.deepEqual(
            test.safety.map(({ active, target }) => ({ active, windowId: target.windowId })),
            [
              { active: true, windowId: 3 },
              { active: false, windowId: 3 },
            ],
          );
        }),
      ),
  );
});

describe("DesktopCuaDriver human input", () => {
  it.effect("claims a person's input only for a macOS helper whose connections report it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const [options, humanInput] of [
          [{ platform: "darwin" }, "supported"],
          [{ platform: "darwin", helperWithoutInput: true }, "unsupported"],
          // Windows agents reach the driver through the desktop's helper, which sees no input.
          [{ platform: "win32" }, "unsupported"],
        ] as const) {
          const test = yield* fixture({ ...options, helper: { granted: true } });
          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");
          assert.equal(test.readiness.at(-1)?.signals.humanInput, humanInput);
        }
      }),
    ),
  );
});

describe("DesktopCuaDriver person stop, session lock, and display wake", () => {
  it.effect("forwards helper personStop events to DesktopTelemetryPublisher", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture({
          platform: "win32",
          helper: { granted: true },
        });
        yield* test.request("agent");
        assert.equal((yield* test.next).status, "ready");
        yield* test.setWatching(true);
        assert.equal(yield* test.nextHelperWatch, "watch");

        yield* test.raisePersonStop;
        yield* test.nextSafety;
        assert.deepEqual(test.personStopReports, [
          { version: 1, type: "cuaPersonStop", generation: 1, reason: "person_esc" },
        ]);
      }),
    ),
  );

  it.effect.each(["darwin", "win32"] as const)(
    "reports host session lock transitions on %s without auto-resuming on unlock",
    (platform) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({
            platform,
            helper: { granted: true },
          });
          yield* test.request("agent");
          assert.equal((yield* test.next).status, "ready");
          const launchesBefore = test.counts().starts;

          yield* test.setWatching(true);
          assert.equal(yield* test.nextHelperWatch, "watch");
          assert.isEmpty(test.sessionLockReports);

          yield* test.emitPower("lock-screen");
          yield* test.nextSafety;
          yield* test.emitPower("suspend");
          yield* test.nextSafety;
          yield* test.emitPower("resume");
          yield* test.nextSafety;
          yield* test.emitPower("user-did-resign-active");
          yield* test.nextSafety;
          yield* test.emitPower("unlock-screen");
          yield* test.nextSafety;
          yield* test.emitPower("user-did-become-active");
          yield* test.nextSafety;

          assert.deepEqual(
            test.sessionLockReports.map(({ locked, reasons }) => ({ locked, reasons })),
            [
              { locked: true, reasons: ["screen_locked"] },
              { locked: true, reasons: ["screen_locked", "system_suspended"] },
              { locked: true, reasons: ["screen_locked"] },
              { locked: true, reasons: ["screen_locked", "session_deactivated"] },
              { locked: true, reasons: ["session_deactivated"] },
              { locked: false, reasons: [] },
            ],
          );
          assert.equal(test.counts().starts, launchesBefore);
        }),
      ),
  );

  it.effect(
    "holds prevent-display-sleep powerSaveBlocker while watching and releases on inactive and shutdown",
    () =>
      Effect.gen(function* () {
        const test = yield* Effect.scoped(
          Effect.gen(function* () {
            const test = yield* fixture({
              platform: "darwin",
              helper: { granted: true },
            });
            yield* test.request("agent");
            assert.equal((yield* test.next).status, "ready");

            yield* test.setWatching(true);
            assert.equal(yield* test.nextHelperWatch, "watch");
            assert.equal(test.activePowerSaveCount(), 1);
            assert.deepEqual(test.powerSaveEvents, [
              { kind: "start", type: "prevent-display-sleep", id: 1 },
            ]);

            yield* test.setWatching(true);
            yield* test.setWatching(false);
            assert.equal(yield* test.nextHelperWatch, "unwatch");
            assert.equal(test.activePowerSaveCount(), 0);
            assert.deepEqual(test.powerSaveEvents, [
              { kind: "start", type: "prevent-display-sleep", id: 1 },
              { kind: "stop", id: 1 },
            ]);

            yield* test.setWatching(true);
            assert.equal(yield* test.nextHelperWatch, "watch");
            assert.equal(test.activePowerSaveCount(), 1);
            return test;
          }),
        );
        assert.equal(test.activePowerSaveCount(), 0);
        assert.deepEqual(test.powerSaveEvents, [
          { kind: "start", type: "prevent-display-sleep", id: 1 },
          { kind: "stop", id: 1 },
          { kind: "start", type: "prevent-display-sleep", id: 2 },
          { kind: "stop", id: 2 },
        ]);
      }),
  );
});
