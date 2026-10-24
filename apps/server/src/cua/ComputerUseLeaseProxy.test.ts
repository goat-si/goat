import { assert, describe, it } from "@effect/vitest";
import { type ComputerUseLeaseUpdate, computerUseRefusalReason } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { leaseUpdateLines } from "./ComputerUseLeaseProxy.ts";
import { LEASE_END_MESSAGES, MAY_HAVE_ACTED, PAUSE_MESSAGES } from "./ComputerUseLeaseMessages.ts";
import {
  active,
  call,
  CONTROL,
  cutOffCall,
  harness,
  refusedCall,
  type ToolAnswer,
} from "./ComputerUseLeaseProxy.testkit.ts";

describe("ComputerUseLeaseProxy", () => {
  it.effect(
    "draws the overlay before each call, and hides it before a capture reaches the driver",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ overlay: true });
        yield* h.push(active());
        const png = Buffer.alloc(24);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
        png.write("IHDR", 12, "latin1");
        png.writeUInt32BE(1000, 16);
        png.writeUInt32BE(500, 20);
        const window = { pid: 4, window_id: 9 };
        yield* h.send(call(1, "get_window_state", window));
        yield* h.nextToDriver;
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
            },
          }),
        );
        yield* h.nextToProvider;
        yield* h.send(call(2, "click", { ...window, x: 500, y: 250 }));
        yield* h.nextToDriver;
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }));
        yield* h.nextToProvider;
        yield* h.send(call(3, "get_window_state", window));
        yield* h.nextToDriver;
        const shown = { op: "show", pid: 4, windowId: 9, point: { fx: 0.5, fy: 0.5 } };
        assert.deepEqual(h.log, [
          "draw " + JSON.stringify({ op: "hide", reason: "capture" }),
          "send get_window_state",
          "draw " + JSON.stringify({ op: "hide", reason: "idle" }),
          "draw " + JSON.stringify({ ...shown, phase: "acting" }),
          "send click",
          "draw " + JSON.stringify({ ...shown, phase: "resting" }),
          "draw " + JSON.stringify({ op: "hide", reason: "capture" }),
          "send get_window_state",
        ]);
      }),
  );

  it.effect("refuses a call whose draw a pause interrupted, and never forwards it", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const h = yield* harness({
        overlay: (command) =>
          command.op === "show"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate)))
            : Effect.void,
      });
      yield* h.push(active());
      yield* h.send(call(5, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      yield* Deferred.await(entered);
      // The click's draw is still waiting when the person takes over.
      yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
      yield* h.killed;
      yield* Deferred.succeed(gate, undefined);
      const answer = yield* h.nextToProvider;
      assert.equal(answer.id, 5);
      assert.include(JSON.stringify(answer), PAUSE_MESSAGES.takeover);
      assert.notInclude(h.log, "send click");
    }),
  );

  it.effect(
    "answers a call whose reply was still being drawn when Stop came as cut off, and drops the reply",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        const h = yield* harness({
          overlay: (command) =>
            command.op === "show" && command.phase === "resting"
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate)))
              : Effect.void,
        });
        yield* h.push(active());
        yield* h.send(call(6, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
        yield* h.nextToDriver;
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 6,
            result: { content: [{ type: "text", text: "clicked" }] },
          }),
        );
        // The reply's draw is waiting when the person presses Stop.
        yield* Deferred.await(entered);
        yield* h.push({ state: "ended", reason: "stopped" });
        yield* h.killed;
        yield* Deferred.succeed(gate, undefined);
        const answer = yield* h.nextToProvider;
        assert.deepEqual(answer, cutOffCall(6, "stopped"));
        assert.notInclude(JSON.stringify(answer), "clicked");
      }),
  );

  it.effect(
    "drops a reply drawn while a pause is still hiding the overlay; the pause answers the call as cut off",
    () =>
      Effect.gen(function* () {
        const reply = {
          gate: yield* Deferred.make<void>(),
          entered: yield* Deferred.make<void>(),
          resumed: yield* Deferred.make<void>(),
        };
        const hide = { gate: yield* Deferred.make<void>(), entered: yield* Deferred.make<void>() };
        const h = yield* harness({
          overlay: (command) =>
            command.op === "show" && command.phase === "resting"
              ? Deferred.succeed(reply.entered, undefined).pipe(
                  Effect.andThen(Deferred.await(reply.gate)),
                  Effect.andThen(Deferred.succeed(reply.resumed, undefined)),
                )
              : command.op === "hide" && command.reason === "takeover"
                ? Deferred.succeed(hide.entered, undefined).pipe(
                    Effect.andThen(Deferred.await(hide.gate)),
                  )
                : Effect.void,
        });
        yield* h.push(active());
        yield* h.send(call(7, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
        yield* h.nextToDriver;
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            result: { content: [{ type: "text", text: "clicked" }] },
          }),
        );
        yield* Deferred.await(reply.entered);
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
        yield* Deferred.await(hide.entered);
        // The reply's draw finishes first, while the pause is still hiding the overlay.
        yield* Deferred.succeed(reply.gate, undefined);
        yield* Deferred.await(reply.resumed);
        yield* Deferred.succeed(hide.gate, undefined);
        const answer = yield* h.nextToProvider;
        assert.notInclude(JSON.stringify(answer), "clicked");
        assert.include(JSON.stringify(answer), "A person took over the screen");
        assert.include(JSON.stringify(answer), MAY_HAVE_ACTED);
      }),
  );

  it.effect(
    "refuses a call drawn while a pause is still hiding the overlay, before the driver stops",
    () =>
      Effect.gen(function* () {
        const show = { gate: yield* Deferred.make<void>(), entered: yield* Deferred.make<void>() };
        const hide = { gate: yield* Deferred.make<void>(), entered: yield* Deferred.make<void>() };
        const hold = (step: typeof show) =>
          Deferred.succeed(step.entered, undefined).pipe(Effect.andThen(Deferred.await(step.gate)));
        const h = yield* harness({
          overlay: (command) =>
            command.op === "show"
              ? hold(show)
              : command.op === "hide" && command.reason === "takeover"
                ? hold(hide)
                : Effect.void,
        });
        yield* h.push(active());
        yield* h.send(call(5, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
        yield* Deferred.await(show.entered);
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
        // The pause is waiting for its hide to land; the driver is still running.
        yield* Deferred.await(hide.entered);
        yield* Deferred.succeed(show.gate, undefined);
        const first = yield* Effect.raceFirst(
          h.nextToDriver.pipe(Effect.as("driver" as const)),
          h.nextToProvider.pipe(Effect.map((answer) => answer)),
        );
        // Released before asserting: the pause cannot be interrupted, so a failure must not leave
        // it waiting.
        yield* Deferred.succeed(hide.gate, undefined);
        assert.notEqual(first, "driver");
        assert.include(JSON.stringify(first), PAUSE_MESSAGES.takeover);
        yield* h.killed;
        assert.notInclude(h.log, "send click");
      }),
  );

  it.effect("holds a call until the server confirms the lease, then forwards it", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }));
      // The handshake needs no lease; the driver answers it.
      assert.equal((yield* h.nextToDriver).method, "initialize");
      yield* h.send(call(1, "list_apps"));
      yield* h.push(active());
      assert.deepEqual((yield* h.nextToDriver).params, { name: "list_apps", arguments: {} });
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
      assert.deepEqual((yield* h.nextToProvider).id, 1);
    }),
  );

  it.effect(
    "on revoke cancels the call in flight, revokes its session, kills the driver, refuses the next",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push(active());
        yield* h.send(call(7, "run_script", { script: "/* long */", session: "work" }));
        assert.equal((yield* h.nextToDriver).id, 7);
        // The person ends it while run_script is still running and the provider stays up.
        yield* h.push({ state: "ended", reason: "revoked" });
        yield* h.killed;
        assert.deepEqual(yield* h.nextToDriver, {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 7, reason: LEASE_END_MESSAGES.revoked },
        });
        assert.deepEqual(yield* h.nextToProvider, cutOffCall(7, "revoked"));
        yield* h.revokeCalled;
        assert.deepEqual(h.revoked, [["work"]]);
        // A late answer from the dead driver never reaches the provider.
        yield* h.send(call(8, "click", { pid: 1, x: 1, y: 1 }));
        assert.deepEqual(yield* h.nextToProvider, refusedCall(8, "revoked"));
        assert.equal(yield* h.driverQueued, 0);
        yield* h.close;
        assert.equal(yield* Fiber.join(h.proxy), "revoked");
      }),
  );

  it.effect("expires on its own clock with a long call outstanding and no new call", () =>
    Effect.gen(function* () {
      const h = yield* harness({ expiresAt: "1970-01-01T00:10:00.000Z" });
      yield* h.push(active("1970-01-01T00:10:00.000Z"));
      yield* h.send(call(3, "run_steps", { steps: [] }));
      assert.equal((yield* h.nextToDriver).id, 3);
      yield* TestClock.adjust("9 minutes");
      assert.isFalse(yield* h.isKilled);
      yield* TestClock.adjust("1 minute");
      yield* h.killed;
      assert.equal((yield* h.nextToDriver).method, "notifications/cancelled");
      assert.deepEqual(yield* h.nextToProvider, cutOffCall(3, "expired"));
      yield* h.send(call(4, "click"));
      assert.deepEqual(yield* h.nextToProvider, refusedCall(4, "expired"));
    }),
  );

  it.effect.each(["revoked", "expired"] as const)(
    "kills the driver and answers the provider while a session revoke is stuck (%s)",
    (reason) =>
      Effect.gen(function* () {
        const stuck = yield* Deferred.make<void>();
        const h = yield* harness({
          expiresAt: "1970-01-01T00:10:00.000Z",
          revoke: () => Deferred.await(stuck),
        });
        yield* h.push(active("1970-01-01T00:10:00.000Z"));
        yield* h.send(call(7, "run_script", { script: "/* long */", session: "work" }));
        assert.equal((yield* h.nextToDriver).id, 7);
        if (reason === "revoked") yield* h.push({ state: "ended", reason: "revoked" });
        else yield* TestClock.adjust("10 minutes");
        yield* h.killed;
        assert.equal((yield* h.nextToDriver).method, "notifications/cancelled");
        assert.deepEqual(yield* h.nextToProvider, cutOffCall(7, reason));
        // The revoke started after the kill and has still not returned.
        yield* h.revokeCalled;
        assert.isFalse(yield* Deferred.isDone(stuck));
        // Nor does it hold up refusing the next call.
        yield* h.send(call(8, "click"));
        assert.deepEqual(yield* h.nextToProvider, refusedCall(8, reason));
      }),
  );

  it.effect("keeps the earlier of its own deadline and the server's", () =>
    Effect.gen(function* () {
      const h = yield* harness({ expiresAt: "1970-01-01T00:30:00.000Z" });
      yield* h.push(active("1970-01-01T00:05:00.000Z"));
      yield* h.send(call(1, "list_apps"));
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* TestClock.adjust("5 minutes");
      // The timer slept for the original deadline; a call after the server's is still refused.
      yield* h.send(call(2, "click"));
      assert.deepEqual((yield* h.nextToProvider).id, 1);
      assert.deepEqual(yield* h.nextToProvider, refusedCall(2, "expired"));
    }),
  );

  it.effect(
    "tells the agent the helper stopped or restarted when the driver exits on its own (#1233)",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push(active());
        yield* h.send(call(1, "click"));
        assert.equal((yield* h.nextToDriver).id, 1);
        yield* h.driverExits;
        assert.deepEqual(yield* h.nextToProvider, cutOffCall(1, "helper_restarted"));
        yield* h.send(call(2, "get_window_state"));
        assert.deepEqual(yield* h.nextToProvider, refusedCall(2, "helper_restarted"));
        assert.equal(computerUseRefusalReason("helper_restarted"), "helperUnavailable");
      }),
  );

  it.effect("fails closed when the lease stream drops, and before any confirmation", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.send(call(1, "click"));
      yield* h.failLeaseStream;
      yield* h.killed;
      assert.deepEqual(yield* h.nextToProvider, refusedCall(1, "lost"));
      assert.equal(yield* h.driverQueued, 0);
    }),
  );

  it.effect("treats an update for another control, or computer use turned off, as ended", () =>
    Effect.gen(function* () {
      const other = yield* harness();
      yield* other.push({ ...active(), controlId: "control:other" } as ComputerUseLeaseUpdate);
      yield* other.killed;
      yield* other.send(call(1, "click"));
      assert.deepEqual(yield* other.nextToProvider, refusedCall(1, "lost"));

      const disabled = yield* harness();
      yield* disabled.push(active());
      yield* disabled.push({ state: "ended", reason: "disabled" });
      yield* disabled.killed;
      yield* disabled.send(call(2, "click"));
      assert.deepEqual(yield* disabled.nextToProvider, refusedCall(2, "disabled"));
    }),
  );

  it.effect("on Stop kills the driver mid-call and tells the agent not to go on", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      yield* h.send(call(1, "run_script", { script: "/* long */" }));
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.push({ state: "ended", reason: "stopped" });
      yield* h.killed;
      assert.equal((yield* h.nextToDriver).method, "notifications/cancelled");
      assert.deepEqual(yield* h.nextToProvider, cutOffCall(1, "stopped"));
      yield* h.close;
      assert.equal(yield* Fiber.join(h.proxy), "stopped");
    }),
  );

  it.effect(
    "pauses for a person's input: kills the call in flight, refuses until handed back, then restarts the driver",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const initialize = JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { v: 1 },
        });
        const initialized = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
        yield* h.send(initialize);
        yield* h.send(initialized);
        assert.equal((yield* h.nextToDriver).method, "initialize");
        assert.equal((yield* h.nextToDriver).method, "notifications/initialized");
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 0, result: {} }));
        assert.equal((yield* h.nextToProvider).id, 0);
        yield* h.push(active());
        yield* h.send(call(1, "drag", { pid: 4, window_id: 9 }));
        assert.equal((yield* h.nextToDriver).id, 1);

        yield* h.push({ state: "paused", controlId: CONTROL, reason: "human_input" });
        yield* h.killed;
        assert.equal((yield* h.nextToDriver).method, "notifications/cancelled");
        // The drag was already with the driver: it may have moved something, so no refusal.
        const cutOff = (yield* h.nextToProvider) as unknown as ToolAnswer;
        assert.equal(cutOff.id, 1);
        assert.deepEqual(cutOff.result.structuredContent, {
          effect: "unverifiable",
          code: "interrupted",
          detail: "waiting_for_human",
        });
        assert.include(cutOff.result.content[0]?.text, MAY_HAVE_ACTED);
        const waiting = {
          jsonrpc: "2.0",
          result: {
            content: [{ type: "text", text: PAUSE_MESSAGES.human_input }],
            structuredContent: { refused: "userIntervened", detail: "waiting_for_human" },
            isError: true,
          },
        };
        yield* h.send(call(2, "click", { pid: 4, window_id: 9 }));
        assert.deepEqual(yield* h.nextToProvider, { ...waiting, id: 2 });

        yield* h.push(active());
        yield* h.restarted;
        // The fresh child hears the handshake under the proxy's own id, and its answer stays inside.
        const replayed = yield* h.nextToDriver;
        assert.deepInclude(replayed, { method: "initialize", params: { v: 1 } });
        assert.match(String(replayed.id), /^goat-proxy:/);
        assert.equal((yield* h.nextToDriver).method, "notifications/initialized");
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: replayed.id, result: {} }));
        yield* h.send(call(3, "click", { pid: 4, window_id: 9 }));
        assert.equal((yield* h.nextToDriver).id, 3);
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [] } }));
        assert.equal((yield* h.nextToProvider).id, 3);
      }),
  );

  it.effect(
    "lets a thread act only on its approved apps, asking the driver which app a pid is",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push(active(undefined, ["com.apple.calculator"]));
        yield* h.send(call(1, "click", { target: { kind: "window", pid: 42, window_id: 1 } }));
        const lookup = yield* h.nextToDriver;
        assert.deepEqual(lookup.params, { name: "list_apps", arguments: {} });
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: lookup.id,
            result: {
              structuredContent: {
                apps: [
                  { pid: 42, bundle_id: "com.apple.calculator", name: "Calculator" },
                  { pid: 7, bundle_id: "com.apple.Terminal", name: "Terminal" },
                ],
              },
            },
          }),
        );
        assert.equal((yield* h.nextToDriver).id, 1);

        yield* h.send(
          call(2, "type_text", {
            text: "rm -rf ~",
            target: { kind: "window", pid: 7, window_id: 3 },
          }),
        );
        const refused = yield* h.nextToProvider;
        assert.deepInclude(
          (refused.result as Record<string, unknown>).structuredContent as object,
          {
            refused: "appNotAllowed",
            app: "com.apple.Terminal",
          },
        );
        for (const [id, name, args] of [
          [4, "press_key", { key: "return" }],
          [5, "run_script", { script: "click()" }],
        ] as const) {
          yield* h.send(call(id, name, args));
          const answer = yield* h.nextToProvider;
          assert.equal(answer.id, id);
          assert.deepInclude(
            (answer.result as Record<string, unknown>).structuredContent as object,
            {
              refused: "targetRefused",
              detail: "desktop_not_approved",
            },
          );
        }
        // Listing what is on screen touches no app.
        yield* h.send(call(6, "list_windows"));
        assert.equal((yield* h.nextToDriver).id, 6);
        assert.equal(yield* h.driverQueued, 0);
      }),
  );

  it.effect(
    "never screenshots the whole display, even for a thread approved for the whole screen",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        // No app list: this thread may act on anything the screen shows.
        yield* h.push(active());
        yield* h.send(call(1, "get_desktop_state", { max_image_dimension: 800 }));
        const refused = yield* h.nextToProvider;
        assert.equal(refused.id, 1);
        const result = refused.result as {
          content: ReadonlyArray<{ type: string; text?: string }>;
          structuredContent: object;
        };
        assert.deepInclude(result.structuredContent, {
          refused: "targetRefused",
          detail: "desktop_capture_off",
        });
        assert.isFalse(result.content.some((part) => part.type === "image"));
        assert.include(result.content[0]?.text ?? "", "get_window_state");
        assert.equal(yield* h.driverQueued, 0);

        // One window's screenshot still goes to the driver.
        yield* h.send(call(2, "get_window_state", { pid: 4, window_id: 9 }));
        assert.equal((yield* h.nextToDriver).id, 2);
      }),
  );

  it.effect("stops a running call when its app loses approval, and drops its late answer", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active(undefined, ["com.apple.calculator", "com.apple.Notes"]));
      yield* h.send(call(1, "list_apps"));
      yield* h.nextToDriver;
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { structuredContent: { apps: [{ pid: 9, bundle_id: "com.apple.Notes" }] } },
        }),
      );
      assert.equal((yield* h.nextToProvider).id, 1);
      yield* h.send(
        call(2, "type_text", { text: "long note", target: { kind: "window", pid: 9 } }),
      );
      assert.equal((yield* h.nextToDriver).id, 2);
      // A person ends the Notes grant while the call runs.
      yield* h.push(active(undefined, ["com.apple.calculator"]));
      yield* h.killed;
      assert.equal((yield* h.nextToDriver).method, "notifications/cancelled");
      const refused = yield* h.nextToProvider;
      assert.equal(refused.id, 2);
      assert.deepInclude((refused.result as Record<string, unknown>).structuredContent as object, {
        detail: "app_not_approved",
      });
      yield* h.restarted;
      assert.equal(yield* h.providerQueued, 0);
    }),
  );

  it.effect(
    "refuses a call held for a proxy whose first word is paused, and never runs it on hand back",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.send(call(1, "click", { pid: 4, window_id: 9 }));
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "human_input" });
        const refused = yield* h.nextToProvider;
        assert.equal(refused.id, 1);
        assert.deepInclude(
          (refused.result as Record<string, unknown>).structuredContent as object,
          {
            refused: "userIntervened",
          },
        );
        yield* h.push(active());
        yield* h.restarted;
        yield* h.send(call(2, "list_windows"));
        // The fresh child sees only the new call; the held click is gone.
        assert.equal((yield* h.nextToDriver).id, 2);
      }),
  );

  it.effect(
    "reports the window each forwarded call names to the server once per change, observations included",
    () =>
      Effect.gen(function* () {
        let accept = false;
        const h = yield* harness({ onTarget: () => accept });
        yield* h.push(active());
        // A rejected report is not remembered, so the same window is reported again.
        yield* h.send(call(1, "zoom", { pid: 4, window_id: 9 }));
        assert.deepEqual(yield* h.reported, { pid: 4, windowId: 9 });
        assert.equal((yield* h.nextToDriver).id, 1);
        accept = true;
        yield* h.send(call(2, "get_window_state", { pid: 4, window_id: 9 }));
        assert.deepEqual(yield* h.reported, { pid: 4, windowId: 9 });
        assert.equal((yield* h.nextToDriver).id, 2);
        yield* h.send(call(3, "click", { target: { kind: "window", pid: 4, window_id: 9 } }));
        yield* h.send(call(4, "list_apps"));
        assert.equal((yield* h.nextToDriver).id, 3);
        assert.equal((yield* h.nextToDriver).id, 4);
        assert.equal(yield* h.reportedQueued, 0);
        yield* h.send(call(5, "click", { pid: 6, window_id: 2 }));
        assert.deepEqual(yield* h.reported, { pid: 6, windowId: 2 });
        assert.equal((yield* h.nextToDriver).id, 5);
        // A refused call names nothing: it never ran.
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "private" });
        yield* h.killed;
        yield* h.send(call(6, "click", { pid: 8, window_id: 1 }));
        yield* h.nextToProvider;
        assert.equal(yield* h.reportedQueued, 0);
      }),
  );

  it.effect("pauses for a secret field with a private refusal and resumes by itself", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      yield* h.push({ state: "paused", controlId: CONTROL, reason: "private" });
      yield* h.killed;
      yield* h.send(call(1, "get_window_state", { pid: 4, window_id: 9 }));
      const refused = yield* h.nextToProvider;
      assert.deepInclude((refused.result as Record<string, unknown>).structuredContent as object, {
        detail: "private_mode",
      });
      yield* h.push(active());
      yield* h.restarted;
      yield* h.send(call(2, "get_window_state", { pid: 4, window_id: 9 }));
      assert.equal((yield* h.nextToDriver).id, 2);
    }),
  );

  it.effect(
    "ends the call a secret overlapped even when the pause and its end arrive as one update",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push(active());
        yield* h.send(call(1, "type_text", { text: "hello", target: { kind: "window", pid: 4 } }));
        assert.equal((yield* h.nextToDriver).id, 1);
        // The route read the control only after the secret field had already lost focus.
        yield* h.push({
          ...active(),
          interruptions: { count: 1, last: "private" },
        } as ComputerUseLeaseUpdate);
        yield* h.killed;
        assert.equal((yield* h.nextToDriver).method, "notifications/cancelled");
        const refused = yield* h.nextToProvider;
        assert.equal(refused.id, 1);
        assert.deepInclude(
          (refused.result as Record<string, unknown>).structuredContent as object,
          {
            detail: "private_mode",
          },
        );
        yield* h.restarted;
        // The same count again is no new pause.
        yield* h.push({
          ...active(),
          interruptions: { count: 1, last: "private" },
        } as ComputerUseLeaseUpdate);
        yield* h.send(call(2, "list_windows"));
        assert.equal((yield* h.nextToDriver).id, 2);
      }),
  );

  it.effect(
    "a driver that names windows from another display is cut off: a typed refusal, and the driver killed",
    () =>
      Effect.gen(function* () {
        // The person's own desktop runs pid 900; GOAT gave the driver another screen (#1358).
        const h = yield* harness({ elsewhere: new Set([900]) });
        yield* h.push(active());
        yield* h.send(call(1, "list_windows"));
        assert.equal((yield* h.nextToDriver).id, 1);
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [], structuredContent: { windows: [{ pid: 900, window_id: 5 }] } },
          }),
        );
        assert.deepEqual(yield* h.nextToProvider, refusedCall(1, "wrong_display"));
        yield* h.killed;
        // Nothing after it runs either.
        yield* h.send(call(2, "list_windows"));
        assert.deepEqual(yield* h.nextToProvider, refusedCall(2, "wrong_display"));
      }),
  );

  it.effect("a call naming a window that is not on GOAT's screen never reaches the driver", () =>
    Effect.gen(function* () {
      const h = yield* harness({ elsewhere: new Set([900]) });
      yield* h.push(active());
      // Flat or nested inside a target, the window is checked before anything is sent.
      yield* h.send(call(1, "click", { pid: 900, window_id: 5, x: 1, y: 1 }));
      yield* h.send(call(2, "click", { target: { kind: "window", pid: 900, window_id: 5 } }));
      for (const id of [1, 2]) {
        const refused = yield* h.nextToProvider;
        assert.equal(refused.id, id);
        assert.deepInclude((refused.result as { structuredContent: object }).structuredContent, {
          detail: "wrong_display",
        });
      }
      assert.equal(yield* h.driverQueued, 0);
    }),
  );

  it.effect(
    "nothing acts until the driver has shown its windows are on GOAT's screen (#1358)",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ elsewhere: new Set([900]) });
        yield* h.push(active());
        // A call naming no window at all still waits for the proof.
        yield* h.send(call(1, "type_text", { pid: 10, text: "hi" }));
        const asked = yield* h.nextToDriver;
        assert.deepEqual(asked.params, { name: "list_windows", arguments: {} });
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: asked.id,
            result: { content: [], structuredContent: { windows: [{ pid: 10, window_id: 20 }] } },
          }),
        );
        assert.equal((yield* h.nextToDriver).id, 1);

        // A driver that lists another screen's windows is cut off, and the call never runs.
        const wrong = yield* harness({ elsewhere: new Set([900]) });
        yield* wrong.push(active());
        yield* wrong.send(call(1, "type_text", { pid: 10, text: "hi" }));
        const listed = yield* wrong.nextToDriver;
        yield* wrong.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: listed.id,
            result: { content: [], structuredContent: { windows: [{ pid: 900, window_id: 5 }] } },
          }),
        );
        assert.deepEqual(yield* wrong.nextToProvider, refusedCall(1, "wrong_display"));
        yield* wrong.killed;
        assert.equal(yield* wrong.driverQueued, 0);
      }),
  );

  it.effect("a filtered list_windows that finds nothing does not prove the screen", () =>
    Effect.gen(function* () {
      const h = yield* harness({ elsewhere: new Set([900]) });
      yield* h.push(active());
      yield* h.send(call(1, "list_windows", { pid: 2147483647 }));
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [], structuredContent: { windows: [] } },
        }),
      );
      assert.equal((yield* h.nextToProvider).id, 1);
      // The action still waits for the proxy's own, unfiltered listing.
      yield* h.send(call(2, "type_text", { pid: 900, text: "hi" }));
      assert.deepEqual((yield* h.nextToDriver).params, { name: "list_windows", arguments: {} });
    }),
  );

  it.effect("a call waiting on its window check when the person takes over never runs", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const h = yield* harness({ elsewhere: new Set([900]), placementGate: gate });
      yield* h.push(active());
      yield* h.send(call(1, "click", { pid: 10, window_id: 20, x: 1, y: 1 }));
      yield* h.checking;
      yield* h.push({ state: "paused", controlId: CONTROL, reason: "human_input" });
      yield* h.push(active());
      yield* h.restarted;
      yield* Deferred.succeed(gate, undefined);
      // The replacement child proves its screen, yet the click from before the takeover is refused.
      const asked = yield* h.nextToDriver;
      assert.deepEqual(asked.params, { name: "list_windows", arguments: {} });
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: asked.id,
          result: { content: [], structuredContent: { windows: [{ pid: 10, window_id: 20 }] } },
        }),
      );
      const refused = yield* h.nextToProvider;
      assert.equal(refused.id, 1);
      assert.deepInclude((refused.result as { structuredContent: object }).structuredContent, {
        detail: "waiting_for_human",
      });
      assert.equal(yield* h.driverQueued, 0);
    }),
  );

  it.effect("a reply still being checked when the person stops is never delivered", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const h = yield* harness({ elsewhere: new Set([900]), placementGate: gate });
      yield* h.push(active());
      yield* h.send(call(1, "list_windows"));
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [], structuredContent: { windows: [{ pid: 10, window_id: 20 }] } },
        }),
      );
      yield* h.push({ state: "ended", reason: "stopped" });
      assert.deepEqual(yield* h.nextToProvider, cutOffCall(1, "stopped", true));
      yield* Deferred.succeed(gate, undefined);
      yield* h.killed;
      assert.equal(yield* h.providerQueued, 0);
    }),
  );

  it.effect("drops a driver reply to a request the provider cancelled or never made", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      yield* h.send(call(3, "list_apps"));
      assert.equal((yield* h.nextToDriver).id, 3);
      const cancel = {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 3 },
      };
      yield* h.send(JSON.stringify(cancel));
      assert.deepEqual(yield* h.nextToDriver, cancel);
      // Driver lines arrive in order, so the next reply reaching the provider proves these dropped.
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [] } }));
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 99, result: { content: [] } }));
      yield* h.send(call(4, "list_apps"));
      assert.equal((yield* h.nextToDriver).id, 4);
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 4, result: { content: [] } }));
      assert.equal((yield* h.nextToProvider).id, 4);
    }),
  );

  it.effect("reads NDJSON lease lines and drops ones it cannot decode", () =>
    Effect.gen(function* () {
      const updates = yield* Stream.runCollect(
        leaseUpdateLines(
          Stream.make(
            JSON.stringify(active()),
            "not json",
            JSON.stringify({ state: "paused" }),
            "",
            JSON.stringify({ state: "ended", reason: "expired" }),
          ),
        ),
      );
      assert.deepEqual(updates, [active(), { state: "ended", reason: "expired" }]);
    }),
  );
});
