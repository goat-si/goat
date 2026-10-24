import { assert, describe, it } from "@effect/vitest";
import {
  type ComputerUseLeaseUpdate,
  type ComputerUseOverlayCommand,
  computerUseRefusalReason,
} from "@goat/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  LEASE_END_MESSAGES,
  leaseUpdateLines,
  PAUSE_MESSAGES,
  runLeaseProxy,
} from "./ComputerUseLeaseProxy.ts";

const CONTROL = "control:one";
const call = (id: number | string, name: string, args: object = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const active = (
  expiresAt = "1970-01-01T00:30:00.000Z",
  apps?: ReadonlyArray<string>,
): ComputerUseLeaseUpdate => ({
  state: "active",
  controlId: CONTROL,
  expiresAt,
  ...(apps === undefined ? {} : { apps }),
});

interface FakeDriver {
  readonly toDriver: Queue.Queue<string>;
  readonly fromDriver: Queue.Queue<string, Cause.Done>;
  readonly killed: Deferred.Deferred<void>;
}

/** A proxy over in-memory stdio, lease stream and drivers, on the TestClock (epoch 0). */
const harness = Effect.fn(function* (
  options: {
    readonly expiresAt?: string;
    /** Stands in for `cua-driver revoke`; defaults to recording and returning at once. */
    readonly revoke?: (sessions: ReadonlyArray<string>) => Effect.Effect<void>;
    /**
     * Gives each driver an overlay channel; draws and sends land in `log` in order. With a gate,
     * every "show" signals `entered` and then waits for `gate`, like a helper slow to draw.
     */
    readonly overlay?: boolean | ((command: ComputerUseOverlayCommand) => Effect.Effect<void>);
  } = {},
) {
  const input = yield* Queue.unbounded<string, Cause.Done>();
  const output = yield* Queue.unbounded<string>();
  const updates = yield* Queue.unbounded<ComputerUseLeaseUpdate, Cause.Done | string>();
  const drivers: Array<FakeDriver> = [];
  const started = yield* Queue.unbounded<FakeDriver>();
  const revokeCalled = yield* Deferred.make<void>();
  const revoked: Array<ReadonlyArray<string>> = [];
  const log: Array<string> = [];
  const proxy = yield* runLeaseProxy({
    controlId: CONTROL,
    expiresAt: DateTime.makeUnsafe(options.expiresAt ?? "1970-01-01T00:30:00.000Z"),
    input: Stream.fromQueue(input),
    output: (line) => Queue.offer(output, line).pipe(Effect.asVoid),
    leaseUpdates: Stream.fromQueue(updates),
    startDriver: Effect.gen(function* () {
      const driver: FakeDriver = {
        toDriver: yield* Queue.unbounded<string>(),
        fromDriver: yield* Queue.unbounded<string, Cause.Done>(),
        killed: yield* Deferred.make<void>(),
      };
      drivers.push(driver);
      yield* Queue.offer(started, driver);
      return {
        send: (line: string) =>
          Effect.sync(() => {
            const params = (JSON.parse(line) as { params?: { name?: unknown } }).params;
            if (typeof params?.name === "string") log.push("send " + params.name);
          }).pipe(Effect.andThen(Queue.offer(driver.toDriver, line)), Effect.asVoid),
        lines: Stream.fromQueue(driver.fromDriver),
        kill: Deferred.succeed(driver.killed, undefined).pipe(
          Effect.andThen(Queue.end(driver.fromDriver)),
        ),
        ...(options.overlay
          ? {
              overlay: (command: ComputerUseOverlayCommand) =>
                (typeof options.overlay === "function"
                  ? options.overlay(command)
                  : Effect.void
                ).pipe(
                  Effect.andThen(
                    Effect.sync(() => void log.push("draw " + JSON.stringify(command))),
                  ),
                ),
            }
          : {}),
      };
    }),
    revokeSessions: (sessions) =>
      Effect.sync(() => void revoked.push(sessions)).pipe(
        Effect.andThen(Deferred.succeed(revokeCalled, undefined)),
        Effect.andThen(options.revoke?.(sessions) ?? Effect.void),
      ),
  }).pipe(Effect.scoped, Effect.forkChild);
  const first = yield* Queue.take(started);
  const current = () => drivers.at(-1) ?? first;
  const json = (line: string) => JSON.parse(line) as Record<string, unknown>;
  return {
    send: (line: string) => Queue.offer(input, line),
    close: Queue.end(input),
    push: (update: ComputerUseLeaseUpdate) => Queue.offer(updates, update),
    failLeaseStream: Queue.fail(updates, "connection reset"),
    reply: (line: string) => Queue.offer(current().fromDriver, line),
    /** The driver's output ends without the proxy killing it, as when the helper restarts. */
    driverExits: Effect.suspend(() => Queue.end(current().fromDriver)),
    nextToDriver: Effect.suspend(() => Queue.take(current().toDriver)).pipe(Effect.map(json)),
    nextToProvider: Queue.take(output).pipe(Effect.map(json)),
    providerQueued: Queue.size(output),
    driverQueued: Effect.suspend(() => Queue.size(current().toDriver)),
    killed: Effect.suspend(() => Deferred.await(first.killed)),
    isKilled: Effect.suspend(() => Deferred.isDone(first.killed)),
    restarted: Queue.take(started),
    revokeCalled: Deferred.await(revokeCalled),
    revoked,
    log,
    proxy,
  };
});

const refusedCall = (id: number, reason: keyof typeof LEASE_END_MESSAGES) => ({
  jsonrpc: "2.0",
  id,
  result: {
    content: [{ type: "text", text: LEASE_END_MESSAGES[reason] }],
    structuredContent: { refused: computerUseRefusalReason(reason), detail: reason },
    isError: true,
  },
});

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
        assert.deepEqual(yield* h.nextToProvider, refusedCall(7, "revoked"));
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
      assert.deepEqual(yield* h.nextToProvider, refusedCall(3, "expired"));
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
        assert.deepEqual(yield* h.nextToProvider, refusedCall(7, reason));
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
        assert.deepEqual(yield* h.nextToProvider, refusedCall(1, "helper_restarted"));
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
      assert.deepEqual(yield* h.nextToProvider, refusedCall(1, "stopped"));
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
        const waiting = {
          jsonrpc: "2.0",
          result: {
            content: [{ type: "text", text: PAUSE_MESSAGES.human_input }],
            structuredContent: { refused: "userIntervened", detail: "waiting_for_human" },
            isError: true,
          },
        };
        assert.deepEqual(yield* h.nextToProvider, { ...waiting, id: 1 });
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
