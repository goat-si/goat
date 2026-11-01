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
