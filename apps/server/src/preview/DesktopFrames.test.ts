import { assert, describe, it } from "@effect/vitest";
import { type DesktopCuaFrame, type DesktopCuaFrames, ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import {
  admitFrame,
  DesktopFrames,
  type FrameGate,
  frameGate,
  layer,
  planFrames,
} from "./DesktopFrames.ts";

const threadId = ThreadId.make("thread:a");
const expiresAt = DateTime.makeUnsafe(60 * 60_000);
const control: ComputerUseLeases.ComputerUseControl = {
  controlId: "control:a",
  threadId,
  expiresAt,
  target: { pid: 7, windowId: 3 },
};
const sessionId = "desktop:control:a";
const active: ComputerUseLeases.ComputerUseControlState = {
  _tag: "active",
  expiresAt,
  interruptions: { count: 0, last: "human_input" },
  apps: ["com.apple.calculator"],
  wakeAt: DateTime.toEpochMillis(expiresAt),
};
const detects = { humanInput: true, privateMode: true, frames: true } as const;
const target = {
  key: sessionId,
  pid: 7,
  windowId: 3,
  apps: ["com.apple.calculator"],
  maxWidth: 320,
  intervalMs: 500,
};
const frame = (seq: number, data = "QUJD"): Extract<DesktopCuaFrame, { type: "cuaFrame" }> => ({
  version: 1,
  type: "cuaFrame",
  seq,
  key: sessionId,
  width: 320,
  height: 200,
  mime: "image/jpeg",
  data,
});

/** The service over a control whose state a test changes, and a desktop that records requests. */
const fixture = Effect.fnUntraced(function* () {
  const state = yield* Ref.make<ComputerUseLeases.ComputerUseControlState>(active);
  const signals = yield* PubSub.unbounded<void>();
  const requests = yield* Queue.unbounded<DesktopCuaFrames["targets"]>();
  const fromDesktop = yield* PubSub.unbounded<DesktopCuaFrame>();
  const seq = yield* Ref.make(0);
  const unused = Effect.die("unused");
  const leases = ComputerUseLeases.ComputerUseLeases.of({
    active: () => unused,
    holder: () => unused,
    channelOrigin: () => unused,
    state: () => unused,
    control: () => unused,
    controlState: () => unused,
    stop: () => unused,
    setTarget: () => unused,
    stopAll: unused,
    turnEnded: () => unused,
    settle: unused,
    disable: unused,
    grants: unused,
    pause: () => unused,
    detection: Effect.succeed(detects),
    resume: unused,
    sessions: Ref.get(state).pipe(Effect.map((current) => [{ control, state: current }])),
    subscribe: PubSub.subscribe(signals),
    changed: PubSub.publish(signals, undefined).pipe(Effect.asVoid),
    proxy: undefined,
  });
  const desktop = DesktopTelemetryReceiver.layerTest({
    cuaFrames: Stream.fromPubSub(fromDesktop),
    setCuaFrames: (targets) =>
      Queue.offer(requests, targets).pipe(Effect.andThen(Ref.updateAndGet(seq, (n) => n + 1))),
  });
  const service = yield* Layer.build(
    layer.pipe(
      Layer.provide(Layer.succeed(ComputerUseLeases.ComputerUseLeases, leases)),
      Layer.provide(desktop),
    ),
  ).pipe(
    Effect.map((context) => context.mapUnsafe.get(DesktopFrames.key) as DesktopFrames["Service"]),
  );
  return {
    service,
    requested: Queue.take(requests),
    seq: Ref.get(seq),
    send: (message: DesktopCuaFrame) => PubSub.publish(fromDesktop, message),
    set: (next: ComputerUseLeases.ComputerUseControlState) =>
      Ref.set(state, next).pipe(Effect.andThen(leases.changed)),
  };
});

const watch = Effect.fnUntraced(function* (service: DesktopFrames["Service"]) {
  const events = yield* service
    .frames({ sessionId, maxWidth: 320, frameIntervalMs: 500 })
    .pipe(Stream.toQueue({ capacity: "unbounded" }));
  return Queue.take(events);
});

describe("DesktopFrames", () => {
  it.effect(
    "captures the agent's window while its control is active and stops at once on a secret field or Stop",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const next = yield* watch(f.service);
        assert.deepEqual(yield* f.requested, [target]);
        yield* f.send(frame(yield* f.seq));
        assert.deepInclude(yield* next, { type: "frame", seq: 1, width: 320, data: "QUJD" });

        yield* f.set({ _tag: "paused", reason: "private" });
        assert.deepEqual(yield* f.requested, []);
        assert.deepEqual(yield* next, { type: "unavailable", reason: "private" });

        yield* f.set(active);
        assert.deepEqual(yield* f.requested, [target]);
        yield* f.send(frame(yield* f.seq, "TkVX"));
        assert.deepInclude(yield* next, { type: "frame", seq: 2, data: "TkVX" });

        yield* f.set({ _tag: "ended", reason: "stopped" });
        assert.deepEqual(yield* f.requested, []);
        assert.deepEqual(yield* next, { type: "unavailable", reason: "stopped" });
      }).pipe(Effect.scoped),
  );

  it.effect("stops capturing when the last viewer leaves", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const viewer = yield* Scope.make();
      yield* watch(f.service).pipe(Effect.provideService(Scope.Scope, viewer), Effect.asVoid);
      assert.deepEqual(yield* f.requested, [target]);
      yield* Scope.close(viewer, Exit.void);
      assert.deepEqual(yield* f.requested, []);
    }).pipe(Effect.scoped),
  );

  it("closes for every state but an active control with a known window and a helper that sends frames", () => {
    const entry = { control, state: active };
    assert.deepInclude(frameGate(entry, detects), { _tag: "open", pid: 7, windowId: 3 });
    const reason = (gate: ReturnType<typeof frameGate>) =>
      gate._tag === "closed" ? gate.reason : "open";
    assert.equal(reason(frameGate(undefined, detects)), "stopped");
    assert.equal(
      reason(frameGate({ control, state: { _tag: "ended", reason: "expired" } }, detects)),
      "stopped",
    );
    assert.equal(
      reason(frameGate({ control, state: { _tag: "paused", reason: "private" } }, detects)),
      "private",
    );
    assert.equal(
      reason(frameGate({ control, state: { _tag: "paused", reason: "takeover" } }, detects)),
      "paused",
    );
    assert.equal(
      reason(frameGate({ control: { ...control, idle: true }, state: active }, detects)),
      "paused",
    );
    assert.equal(reason(frameGate(entry, { ...detects, frames: false })), "unsupported");
    const { target: _target, ...unnamed } = control;
    assert.equal(reason(frameGate({ control: unnamed, state: active }, detects)), "windowUnknown");
  });

  it("asks for the widest and most frequent viewer, never past the limits, and only for open gates", () => {
    const open = { _tag: "open", pid: 7, windowId: 3, apps: undefined } as const;
    const targets = planFrames(
      new Map<string, FrameGate>([
        ["desktop:b", open],
        ["desktop:c", { _tag: "closed", reason: "private" } as const],
      ]),
      new Map([
        [
          "desktop:b",
          [
            { maxWidth: 200, intervalMs: 2_000 },
            { maxWidth: 480, intervalMs: 500 },
          ],
        ],
        ["desktop:c", [{ maxWidth: 480, intervalMs: 500 }]],
      ]),
    );
    assert.deepEqual(targets, [
      { key: "desktop:b", pid: 7, windowId: 3, maxWidth: 480, intervalMs: 500 },
    ]);
    const capped = planFrames(
      new Map([["desktop:b", open]]),
      new Map([["desktop:b", [{ maxWidth: 4_000, intervalMs: 10 }]]]),
    );
    assert.deepInclude(capped[0], { maxWidth: 480, intervalMs: 500 });
  });

  it("drops a frame from before a stop or for another window, and refuses an oversized one", () => {
    const current = { seq: 4, targets: [target] };
    const open = { _tag: "open", pid: 7, windowId: 3, apps: undefined } as const;
    assert.isDefined(admitFrame(frame(4), current, open));
    assert.isUndefined(admitFrame(frame(3), current, open));
    assert.isUndefined(admitFrame(frame(4), current, { _tag: "closed", reason: "paused" }));
    assert.isUndefined(admitFrame(frame(4), current, { ...open, windowId: 9 }));
    assert.isUndefined(admitFrame({ ...frame(4), key: "desktop:other" }, current, open));
    assert.deepEqual(admitFrame(frame(4, "A".repeat(400_000)), current, open), {
      type: "unavailable",
      reason: "captureFailed",
    });
    assert.deepEqual(admitFrame({ ...frame(4), width: 1_000 }, current, open), {
      type: "unavailable",
      reason: "captureFailed",
    });
  });
});
