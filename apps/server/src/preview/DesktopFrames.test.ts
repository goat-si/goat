import { assert, describe, it } from "@effect/vitest";
import {
  type DesktopCuaFrame,
  type DesktopCuaFrames,
  type DesktopCuaReadinessReport,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import * as LinuxFrameSource from "../cua/linuxFrames/LinuxFrameSource.ts";
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

/** A desktop helper's readiness report, saying whether it sends window frames itself. */
const readinessReport = (frames: boolean): DesktopCuaReadinessReport => ({
  version: 1,
  type: "cuaReadiness",
  generation: 1,
  readiness: {
    grants: { accessibility: "granted", screenCapture: "granted" },
    helper: "authenticated",
    capture: "ready",
    tree: "ready",
    input: "background",
    blockers: [],
    reasons: [],
  },
  signals: { privateMode: "supported", humanInput: "supported" },
  frames,
});

/** The service over a control whose state a test changes, and a desktop that records requests. */
const fixture = Effect.fnUntraced(function* (
  options: {
    /** A Linux server's own capture beside the desktop pipe (#1370). */
    readonly linux?: boolean;
    /** The desktop host's helper says it captures frames itself. */
    readonly desktopCaptures?: boolean;
  } = {},
) {
  const linuxRequests = yield* Queue.unbounded<{
    readonly seq: number;
    readonly targets: DesktopCuaFrames["targets"];
  }>();
  const fromLinux = yield* PubSub.unbounded<DesktopCuaFrame>();
  const desktopCaptures = yield* Ref.make(options.desktopCaptures === true);
  const safety = yield* PubSub.unbounded<DesktopCuaReadinessReport>();
  const state = yield* Ref.make<ComputerUseLeases.ComputerUseControlState>(active);
  const record = yield* Ref.make(control);
  const signals = yield* PubSub.unbounded<void>();
  const requests = yield* Queue.unbounded<DesktopCuaFrames["targets"]>();
  const fromDesktop = yield* PubSub.unbounded<DesktopCuaFrame>();
  const seq = yield* Ref.make(0);
  const failNext = yield* Ref.make(false);
  const blockNext = yield* Ref.make<Option.Option<Deferred.Deferred<void>>>(Option.none());
  const hold = yield* Ref.make<
    Option.Option<{ reading: Deferred.Deferred<void>; release: Deferred.Deferred<void> }>
  >(Option.none());
  const unused = Effect.die("unused");
  const leases = ComputerUseLeases.ComputerUseLeases.of({
    blocked: () => unused,
    blockedTurns: unused,
    active: () => unused,
    holder: () => unused,
    channelOrigin: () => unused,
    state: () => unused,
    control: () => unused,
    attached: () => Effect.die("unused"),
    everyAppControl: () => unused,
    nameApps: () => unused,
    serializeAdmission: (effect) => effect,
    currentControl: () => Effect.die("unused"),
    controlState: () => unused,
    stop: () => unused,
    setTarget: () => unused,
    callReservation: () => unused,
    releaseApps: () => Effect.void,
    streamOpened: () => Effect.void,
    foregroundApprovalEpoch: unused,
    approveForeground: () => unused,
    foregroundAvailable: () => unused,
    humanInput: () => unused,
    agentInput: () => unused,
    stopAll: unused,
    turnEnded: () => unused,
    settle: unused,
    disable: unused,
    grants: unused,
    release: () => unused,
    pause: () => unused,
    detection: Effect.succeed(detects),
    resume: unused,
    // A held read returns the state it saw before it was held, like a read awaiting the database.
    sessions: Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const recorded = yield* Ref.get(record);
      const held = yield* Ref.getAndSet(hold, Option.none());
      if (Option.isSome(held)) {
        yield* Deferred.succeed(held.value.reading, undefined);
        yield* Deferred.await(held.value.release);
      }
      return [{ control: recorded, state: current }];
    }),
    subscribe: PubSub.subscribe(signals),
    changed: PubSub.publish(signals, undefined).pipe(Effect.asVoid),
    proxy: undefined,
  });
  const desktop = DesktopTelemetryReceiver.layerTest({
    cuaReadiness: Ref.get(desktopCaptures).pipe(
      Effect.map((frames) => Option.some(readinessReport(frames))),
    ),
    cuaSafety: Stream.fromPubSub(safety),
    cuaFrames: Stream.fromPubSub(fromDesktop),
    setCuaFrames: (targets) =>
      Queue.offer(requests, targets).pipe(
        // The receiver keeps what it was asked for and sends it again when the desktop reconnects.
        Effect.andThen(Ref.updateAndGet(seq, (n) => n + 1)),
        Effect.tap(() =>
          Ref.getAndSet(blockNext, Option.none()).pipe(
            // A write the desktop never takes up; only an interruption ends it.
            Effect.flatMap((writing) =>
              Option.isSome(writing)
                ? Deferred.succeed(writing.value, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.void,
            ),
          ),
        ),
        Effect.andThen((next) =>
          Ref.getAndSet(failNext, false).pipe(
            Effect.flatMap((fail) =>
              fail
                ? Effect.fail(
                    new DesktopTelemetryReceiver.DesktopTelemetryControlFailed({
                      fd: 4,
                      operation: "cuaFrames",
                      cause: "write failed",
                    }),
                  )
                : Effect.succeed(next),
            ),
          ),
        ),
      ),
  });
  const service = yield* Layer.build(
    layer.pipe(
      Layer.provide(Layer.succeed(ComputerUseLeases.ComputerUseLeases, leases)),
      Layer.provide(desktop),
      Layer.provide(
        options.linux
          ? Layer.succeed(
              LinuxFrameSource.LinuxFrameSource,
              LinuxFrameSource.LinuxFrameSource.of({
                supported: Effect.succeed(true),
                setTargets: (seq, targets) => Queue.offer(linuxRequests, { seq, targets }),
                frames: Stream.fromPubSub(fromLinux),
              }),
            )
          : Layer.empty,
      ),
    ),
  ).pipe(
    Effect.map((context) => context.mapUnsafe.get(DesktopFrames.key) as DesktopFrames["Service"]),
  );
  return {
    service,
    requested: Queue.take(requests),
    unrequested: Queue.size(requests),
    seq: Ref.get(seq),
    send: (message: DesktopCuaFrame) => PubSub.publish(fromDesktop, message),
    linuxRequested: Queue.take(linuxRequests),
    sendFromLinux: (message: DesktopCuaFrame) => PubSub.publish(fromLinux, message),
    /** The desktop's helper reports, with nothing else changing, whether it captures frames. */
    reportDesktopCaptures: (frames: boolean) =>
      Ref.set(desktopCaptures, frames).pipe(
        Effect.andThen(PubSub.publish(safety, readinessReport(frames))),
      ),
    set: (next: ComputerUseLeases.ComputerUseControlState) =>
      Ref.set(state, next).pipe(Effect.andThen(leases.changed)),
    /** The control's record changes, as a proxy's cursor report changes it. */
    record: (next: ComputerUseLeases.ComputerUseControl) =>
      Ref.set(record, next).pipe(Effect.andThen(leases.changed)),
    /** A change nothing signals, such as a control reaching its expiry. */
    quietly: (next: ComputerUseLeases.ComputerUseControlState) => Ref.set(state, next),
    failNextWrite: Ref.set(failNext, true),
    blockNextWrite: Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      yield* Ref.set(blockNext, Option.some(writing));
      return writing;
    }),
    holdNextRead: Effect.gen(function* () {
      const held = {
        reading: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      yield* Ref.set(hold, Option.some(held));
      return held;
    }),
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
        yield* TestClock.adjust("500 millis");
        yield* f.send(frame(yield* f.seq, "TkVX"));
        assert.deepInclude(yield* next, { type: "frame", seq: 2, data: "TkVX" });

        yield* f.set({ _tag: "ended", reason: "stopped" });
        assert.deepEqual(yield* f.requested, []);
        assert.deepEqual(yield* next, { type: "unavailable", reason: "stopped" });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a Linux server captures its own windows: the same targets and seq, its frames shown, withdrawn on Stop",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ linux: true });
        const next = yield* watch(f.service);
        assert.deepEqual(yield* f.requested, [target]);
        const asked = yield* f.linuxRequested;
        assert.deepEqual(asked, { seq: yield* f.seq, targets: [target] });
        yield* f.sendFromLinux(frame(asked.seq));
        assert.deepInclude(yield* next, { type: "frame", seq: 1, data: "QUJD" });
        yield* f.set({ _tag: "ended", reason: "stopped" });
        assert.deepEqual((yield* f.linuxRequested).targets, []);
        assert.deepEqual(yield* next, { type: "unavailable", reason: "stopped" });
      }).pipe(Effect.scoped),
  );

  it.effect("a desktop host whose helper captures frames leaves the Linux source idle", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ linux: true, desktopCaptures: true });
      yield* Effect.asVoid(watch(f.service));
      assert.deepEqual(yield* f.requested, [target]);
      assert.deepEqual((yield* f.linuxRequested).targets, []);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a helper that starts or stops sending frames takes the targets over from the Linux source, or hands them back",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ linux: true });
        const next = yield* watch(f.service);
        assert.deepEqual(yield* f.requested, [target]);
        const asked = yield* f.linuxRequested;
        assert.deepEqual(asked.targets, [target]);
        // Same targets and seq; only the helper's readiness changes.
        yield* f.reportDesktopCaptures(true);
        assert.deepEqual(yield* f.linuxRequested, { seq: asked.seq, targets: [] });
        // A late Linux frame for the same seq is not shown; the helper's is.
        yield* f.sendFromLinux(frame(asked.seq, "TElOVVg="));
        yield* f.send(frame(asked.seq, "REVTSw=="));
        assert.deepInclude(yield* next, { type: "frame", data: "REVTSw==" });
        yield* f.reportDesktopCaptures(false);
        assert.deepEqual(yield* f.linuxRequested, { seq: asked.seq, targets: [target] });
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

  it.effect("never shows a frame whose check overlapped a privacy pause", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const next = yield* watch(f.service);
      assert.deepEqual(yield* f.requested, [target]);
      const held = yield* f.holdNextRead;
      yield* f.send(frame(yield* f.seq));
      yield* Deferred.await(held.reading);
      yield* f.set({ _tag: "paused", reason: "private" });
      yield* Deferred.succeed(held.release, undefined);
      assert.deepEqual(yield* next, { type: "unavailable", reason: "private" });
      assert.deepEqual(yield* f.requested, []);

      yield* f.set(active);
      assert.deepEqual(yield* f.requested, [target]);
      yield* f.send(frame(yield* f.seq, "TkVX"));
      assert.deepInclude(yield* next, { type: "frame", data: "TkVX" });
    }).pipe(Effect.scoped),
  );

  it.effect("withdraws a capture whose request failed to send, and sends it again", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* Scope.make();
      yield* f.failNextWrite;
      yield* watch(f.service).pipe(Effect.provideService(Scope.Scope, first), Effect.asVoid);
      assert.deepEqual(yield* f.requested, [target]);
      // The receiver may still hold the failed request and replay it when the desktop reconnects.
      yield* Scope.close(first, Exit.void);
      assert.deepEqual(yield* f.requested, []);

      yield* f.failNextWrite;
      yield* Effect.asVoid(watch(f.service));
      assert.deepEqual(yield* f.requested, [target]);
      yield* TestClock.adjust("1 second");
      assert.deepEqual(yield* f.requested, [target]);
    }).pipe(Effect.scoped),
  );

  it.effect("withdraws a capture whose request was cut off mid-write by its viewer leaving", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const writing = yield* f.blockNextWrite;
      const viewer = yield* Scope.make();
      yield* watch(f.service).pipe(Effect.provideService(Scope.Scope, viewer), Effect.asVoid);
      yield* Deferred.await(writing);
      assert.deepEqual(yield* f.requested, [target]);
      yield* Scope.close(viewer, Exit.void);
      assert.deepEqual(yield* f.requested, []);
    }).pipe(Effect.scoped),
  );

  it.effect("drops a frame whose check began before the control lapsed", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.quietly({ ...active, wakeAt: 1_000 });
      const next = yield* watch(f.service);
      assert.deepEqual(yield* f.requested, [target]);
      const held = yield* f.holdNextRead;
      yield* f.send(frame(yield* f.seq));
      yield* Deferred.await(held.reading);
      yield* f.quietly({ _tag: "ended", reason: "expired" });
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(held.release, undefined);
      assert.deepEqual(yield* next, { type: "unavailable", reason: "stopped" });
    }).pipe(Effect.scoped),
  );

  it.effect("never asks to capture for a control read as active after it lapsed", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.quietly({ ...active, wakeAt: 1_000 });
      const held = yield* f.holdNextRead;
      const next = yield* watch(f.service);
      yield* Deferred.await(held.reading);
      yield* f.quietly({ _tag: "ended", reason: "expired" });
      yield* TestClock.adjust("1 second");
      yield* Deferred.succeed(held.release, undefined);
      yield* TestClock.adjust("1 second");
      assert.deepEqual(yield* next, { type: "unavailable", reason: "stopped" });
      assert.equal(yield* f.unrequested, 0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "pairs a frame only with a cursor that changed before its capture, and says how old it is",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const next = yield* watch(f.service);
        yield* f.requested;
        const report = (sequence: number, fx: number) =>
          ({
            identity: {
              environmentId: EnvironmentId.make("env"),
              runId: "run",
              turnId: "turn",
              targetId: "target",
              generation: 1,
              sequence,
            },
            cursor: { windowId: 3, point: { fx, fy: 0.5 }, phase: "moving" },
            phase: "moving",
          }) as const;
        const pointAt = (sequence: number, fx: number, cursorAt: number) => ({
          ...control,
          cursor: { windowId: 3, point: { fx, fy: 0.5 }, phase: "acting" } as const,
          cursorReport: report(sequence, fx),
          cursorAt,
        });
        const captured = (data: string, capturedAt?: number) =>
          Effect.flatMap(f.seq, (seq) =>
            f.send({ ...frame(seq, data), ...(capturedAt === undefined ? {} : { capturedAt }) }),
          );
        yield* TestClock.adjust("1 second");
        yield* f.record(pointAt(1, 0.25, 900));
        yield* captured("QUJD", 950);
        assert.deepInclude(yield* next, {
          type: "frame",
          capturedAt: 950,
          ageMs: 50,
          cursor: { windowId: 3, point: { fx: 0.25, fy: 0.5 }, phase: "acting" },
          cursorState: { identity: report(1, 0.25).identity, phase: "moving" },
        });
        // Captured at 1300, before the cursor moved at 1400, and arriving after: no cursor at all.
        yield* TestClock.adjust("500 millis");
        yield* f.record(pointAt(2, 0.75, 1_400));
        yield* captured("TkVX", 1_300);
        const before = yield* next;
        assert.deepInclude(before, { type: "frame", capturedAt: 1_300, ageMs: 200 });
        assert.notProperty(before, "cursor");
        assert.notProperty(before, "cursorState");
        // The same millisecond cannot say which came first.
        yield* TestClock.adjust("500 millis");
        yield* captured("T0xE", 1_400);
        assert.notProperty(yield* next, "cursor");
        yield* TestClock.adjust("500 millis");
        yield* captured("TkVX", 2_400);
        assert.deepInclude((yield* next) as object, { cursor: pointAt(2, 0.75, 1_400).cursor });
        // A helper that stamps nothing: its arrival says nothing about the pixels, so no cursor.
        yield* TestClock.adjust("500 millis");
        yield* captured("R09ORQ==");
        const unstamped = yield* next;
        assert.deepInclude(unstamped, { type: "frame", capturedAt: 3_000 });
        assert.notProperty(unstamped, "cursor");
        assert.notProperty(unstamped, "ageMs");
      }).pipe(Effect.scoped),
  );

  it.effect("shows at most one frame per interval however fast the desktop sends them", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const next = yield* watch(f.service);
      assert.deepEqual(yield* f.requested, [target]);
      const seq = yield* f.seq;
      yield* f.send(frame(seq));
      assert.deepInclude(yield* next, { type: "frame", seq: 1 });
      yield* f.send(frame(seq, "QkJC"));
      yield* TestClock.adjust("500 millis");
      yield* f.send(frame(seq, "Q0ND"));
      assert.deepInclude(yield* next, { type: "frame", seq: 2, data: "Q0ND" });
    }).pipe(Effect.scoped),
  );

  it.effect("withdraws the capture when the control lapses, without waiting for a signal", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.quietly({ ...active, wakeAt: 1_000 });
      const next = yield* watch(f.service);
      assert.deepEqual(yield* f.requested, [target]);
      yield* f.quietly({ _tag: "ended", reason: "expired" });
      yield* TestClock.adjust("1 second");
      assert.deepEqual(yield* f.requested, []);
      assert.deepEqual(yield* next, { type: "unavailable", reason: "stopped" });
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
    const open = { _tag: "open", pid: 7, windowId: 3, apps: undefined, wakeAt: 60_000 } as const;
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
    const admit = (message: DesktopCuaFrame, at: typeof current, gate: FrameGate | undefined) =>
      admitFrame(message, at, gate, 0);
    const open = {
      _tag: "open",
      pid: 7,
      windowId: 3,
      apps: ["com.apple.calculator"],
      wakeAt: 60_000,
    } as const;
    assert.isDefined(admit(frame(4), current, open));
    assert.isUndefined(admit(frame(3), current, open));
    assert.isUndefined(admit(frame(4), current, { _tag: "closed", reason: "paused" }));
    assert.isUndefined(admit(frame(4), current, { ...open, windowId: 9 }));
    assert.isUndefined(admit({ ...frame(4), key: "desktop:other" }, current, open));
    // Grants narrowed since the capture was asked for: the helper checked against the old apps.
    assert.isUndefined(admit(frame(4), current, { ...open, apps: [] }));
    assert.isUndefined(admit(frame(4), current, { ...open, apps: undefined }));
    assert.deepEqual(admit(frame(4, "A".repeat(400_000)), current, open), {
      type: "unavailable",
      reason: "captureFailed",
    });
    assert.deepEqual(admit({ ...frame(4), width: 1_000 }, current, open), {
      type: "unavailable",
      reason: "captureFailed",
    });
  });
});
