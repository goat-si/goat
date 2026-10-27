import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import { SCREENSHOT_FILE_REFUSED } from "./ComputerUseCaptureFiles.ts";
import { active, call, CONTROL, harness } from "./ComputerUseLeaseProxy.testkit.ts";
import { snapshot, threadHarness } from "./ComputerUseLeaseProxyThread.testkit.ts";
import { linuxScreenshotPolicy } from "./ComputerUseLinuxScreenshots.ts";
import { CROPPED_CAPTURE } from "./linuxHelper/windowCapture.ts";

// The proxy options runLeaseProxyCli gives each desktop: the macOS helper draws the overlay, and
// only Linux has a screenshot policy.
const desktops = [
  ["macOS", { overlay: true }],
  ["Windows", {}],
  ["Linux", { screenshots: linuxScreenshotPolicy({ route: "refused", reason: CROPPED_CAPTURE }) }],
] as const;

// run_steps passes an observe step's arguments through; a script names them in its text.
const fileArguments = [
  { pid: 4, window_id: 9, screenshot_out_file: "/tmp/shot.png" },
  { pid: 4, window_id: 9, image_path: "/tmp/shot.png" },
  { pid: 4, window_id: 9, file_path: "/tmp/shot.png" },
  { steps: [{ action: "click" }], observe: { window_id: 9, screenshot_out_file: "/tmp/s.png" } },
  { steps: [{ observe: [{ window_id: 9, image_path: "/tmp/s.png" }] }] },
  { script: 'get_window_state(window_id=9, image_path="/tmp/s.png")' },
];

describe("capture file arguments (#1688)", () => {
  it.effect.each(desktops)(
    "on %s, a call that asks the driver to write a capture to a file never reaches it",
    ([, options]) =>
      Effect.gen(function* () {
        const h = yield* harness(options);
        yield* h.push(active());
        yield* h.applied;
        for (const [index, args] of fileArguments.entries()) {
          yield* h.send(call(index + 1, "get_window_state", args));
          const answer = yield* Effect.raceFirst(h.nextToProvider, h.nextToDriver);
          assert.equal(answer.id, index + 1);
          assert.include(JSON.stringify(answer), SCREENSHOT_FILE_REFUSED);
          assert.equal(yield* h.driverQueued, 0);
        }
        yield* h.send(call(99, "get_window_state", { pid: 4, window_id: 9 }));
        assert.equal((yield* h.nextToDriver).id, 99);
      }),
  );

  it.effect.each(desktops)(
    "on %s, a screen primitive that asks for a capture file never reaches the driver",
    ([, options]) =>
      Effect.gen(function* () {
        const h = yield* harness(options);
        yield* h.push(active());
        const current = yield* h.driverStarted;
        yield* h.sendPrimitive({
          state: "primitive-request",
          requestId: "request:file",
          registrationId: "registration:one",
          controlId: CONTROL,
          connectionGeneration: current.connectionId,
          runId: "run:one",
          turnId: "cell:one",
          callId: 0,
          deadlineMillis: 1_000,
          tool: "get_window_state",
          args: { pid: 4, window_id: 9, screenshot_out_file: "/tmp/shot.png" },
        });
        const answer = yield* Effect.raceFirst(h.primitiveReply, h.nextToDriver);
        assert.include(JSON.stringify(answer), SCREENSHOT_FILE_REFUSED);
        assert.equal(yield* h.driverQueued, 0);
      }),
  );

  it.effect("thread-follow refuses a capture file argument before any driver hears it", () =>
    Effect.gen(function* () {
      const h = yield* threadHarness();
      yield* h.push(snapshot("A"));
      const driver = yield* h.started;
      yield* h.applied;
      yield* h.send(call(1, "get_window_state", { pid: 42, window_id: 7, file_path: "/tmp/s" }));
      const answer = yield* Effect.raceFirst(h.next, Queue.take(driver.sent));
      assert.include(JSON.stringify(answer), SCREENSHOT_FILE_REFUSED);
      assert.equal(yield* Queue.size(driver.sent), 0);
    }),
  );

  it.effect.each(desktops)(
    "on %s, no capture file is asked for while Private or after Stop",
    ([, options]) =>
      Effect.gen(function* () {
        const h = yield* harness(options);
        yield* h.push(active());
        yield* h.applied;
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "private" });
        yield* h.killed;
        yield* h.send(call(1, "get_window_state", fileArguments[0]));
        assert.equal((yield* h.nextToProvider).id, 1);
        yield* h.push({ state: "ended", reason: "stopped" });
        yield* h.send(call(2, "get_window_state", fileArguments[0]));
        assert.equal((yield* h.nextToProvider).id, 2);
        assert.equal(yield* h.driverQueued, 0);
      }),
  );
});
