import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import { SCREENSHOT_FILE_REFUSED } from "./ComputerUseCaptureFiles.ts";
import { LEASE_END_MESSAGES, PAUSE_MESSAGES } from "./ComputerUseLeaseMessages.ts";
import {
  active,
  call,
  CONTROL,
  foregroundActive,
  harness,
} from "./ComputerUseLeaseProxy.testkit.ts";
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

// Text that only mentions an argument's name asks for no file.
const allowedCalls = [
  ["get_window_state", { pid: 4, window_id: 9 }],
  ["get_window_state", { pid: 4, window_id: 9, query: "image_path" }],
  ["type_text", { pid: 4, window_id: 9, text: "Rename file_path to outputPath" }],
  ["set_value", { pid: 4, window_id: 9, element_index: 1, value: "screenshot_out_file" }],
  [
    "run_steps",
    {
      steps: [{ type: "click", pid: 4, window_id: 9 }],
      observe: { window_id: 9 },
      app_scope: { apps: ["com.example.app4"] },
    },
  ],
] as const;

describe("capture file arguments (#1688)", () => {
  it.effect.each(desktops)(
    "on %s, only a call that asks the driver to write a capture to a file is refused",
    ([, options]) =>
      Effect.gen(function* () {
        const h = yield* harness({ ...options, autoAppListing: true });
        // Foreground approval lets run_steps through, so only the file check can refuse.
        yield* h.push(foregroundActive());
        yield* h.applied;
        for (const [index, args] of fileArguments.entries()) {
          yield* h.send(call(index + 1, "get_window_state", args));
          const answer = yield* Effect.raceFirst(h.nextToProvider, h.nextToDriver);
          assert.equal(answer.id, index + 1);
          assert.include(JSON.stringify(answer), SCREENSHOT_FILE_REFUSED);
          assert.equal(yield* h.driverQueued, 0);
        }
        for (const [index, [name, args]] of allowedCalls.entries()) {
          const id = 100 + index;
          yield* h.send(call(id, name, args));
          const sent = yield* Effect.raceFirst(h.nextToDriver, h.nextToProvider);
          assert.deepEqual(sent.params, { name, arguments: args });
          yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [] } }));
          assert.equal((yield* h.nextToProvider).id, id);
        }
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
        assert.equal((answer as { status?: string }).status, "not_started");
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
        yield* h.applied;
        yield* h.killed;
        yield* h.send(call(1, "get_window_state", fileArguments[0]));
        const paused = yield* h.nextToProvider;
        assert.equal(paused.id, 1);
        assert.include(JSON.stringify(paused), PAUSE_MESSAGES.private);
        yield* h.push({ state: "ended", reason: "stopped" });
        yield* h.applied;
        yield* h.send(call(2, "get_window_state", fileArguments[0]));
        const stopped = yield* h.nextToProvider;
        assert.equal(stopped.id, 2);
        assert.include(JSON.stringify(stopped), LEASE_END_MESSAGES.stopped);
        assert.equal(yield* h.driverQueued, 0);
      }),
  );
});
