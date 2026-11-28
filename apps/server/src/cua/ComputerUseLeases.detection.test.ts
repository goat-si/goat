import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type DesktopCuaReadinessReport,
  type DesktopCuaSafetyReport,
  ThreadId,
} from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { runMigrations } from "../persistence/Migrations.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as LinuxFrameSource from "./linuxFrames/LinuxFrameSource.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const thread = ThreadId.make("thread-person");
const otherThread = ThreadId.make("thread-other");

const readinessFor = (
  generation: number,
  signals: DesktopCuaReadinessReport["signals"] = {
    humanInput: "supported",
    privateMode: "unsupported",
  },
): DesktopCuaReadinessReport => ({
  version: 1,
  type: "cuaReadiness",
  generation,
  readiness: {
    grants: { accessibility: "granted", screenCapture: "granted" },
    helper: "authenticated",
    capture: "ready",
    tree: "ready",
    input: "background",
    blockers: [],
    reasons: [],
  },
  signals,
});

it.effect("stops all active controls on cuaPersonStop and ignores stale generations", () =>
  Effect.gen(function* () {
    const reports = yield* Queue.unbounded<DesktopCuaSafetyReport>();
    const accepted = yield* Ref.make(Option.some(readinessFor(2)));
    yield* Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      const signals = yield* leases.subscribe;
      const authorityChanges: Array<{
        readonly kind: string;
        readonly threadId: ThreadId;
        readonly controlId: string;
        readonly terminal?: string;
      }> = [];
      const unsubscribe = leases.onAuthorityChange?.(
        (change) => void authorityChanges.push(change),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe?.()));

      const first = Option.getOrThrow(yield* leases.control(thread, Option.none()));
      yield* PubSub.take(signals);
      const second = Option.getOrThrow(yield* leases.control(otherThread, Option.none()));
      yield* PubSub.take(signals);

      yield* Queue.offer(reports, {
        version: 1,
        type: "cuaPersonStop",
        generation: 1,
        reason: "person_esc",
      });
      yield* Queue.offer(reports, readinessFor(2));
      yield* PubSub.take(signals);
      assert.equal(yield* PubSub.remaining(signals), 0);
      assert.equal((yield* leases.controlState(thread, first.controlId))._tag, "active");
      assert.equal((yield* leases.controlState(otherThread, second.controlId))._tag, "active");
      assert.deepEqual(authorityChanges, []);

      yield* Queue.offer(reports, {
        version: 1,
        type: "cuaPersonStop",
        generation: 2,
        reason: "person_esc",
      });
      yield* PubSub.take(signals);
      assert.deepEqual(yield* leases.controlState(thread, first.controlId), {
        _tag: "ended",
        reason: "stopped_all",
      });
      assert.deepEqual(yield* leases.controlState(otherThread, second.controlId), {
        _tag: "ended",
        reason: "stopped_all",
      });
      assert.deepEqual(
        yield* leases.callReservation(thread, {
          action: "reserve",
          controlId: first.controlId,
          connectionId: "driver:person-stop",
          callId: "click",
          interruptions: 0,
          idleEpoch: 0,
          name: "list_apps",
          args: {},
        }),
        { status: "refused", detail: "stopped_all" },
      );
      assert.deepEqual(authorityChanges, [
        {
          kind: "stop",
          threadId: thread,
          controlId: first.controlId,
          terminal: "stopped_by_person",
        },
        {
          kind: "stop",
          threadId: otherThread,
          controlId: second.controlId,
          terminal: "stopped_by_person",
        },
      ]);

      const third = Option.getOrThrow(yield* leases.control(thread, Option.none()));
      yield* PubSub.take(signals);
      yield* Queue.offer(reports, {
        version: 1,
        type: "cuaPersonStop",
        reason: "person_esc",
      });
      yield* PubSub.take(signals);
      assert.deepEqual(yield* leases.controlState(thread, third.controlId), {
        _tag: "ended",
        reason: "stopped_all",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ComputerUseLeases.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              database,
              NodeServices.layer,
              DesktopTelemetryReceiver.layerTest({
                cuaSafety: Stream.fromQueue(reports),
                cuaReadiness: Ref.get(accepted),
              }),
            ),
          ),
        ),
      ),
    );
  }),
);

it.effect(
  "pauses active controls on cuaSessionLock without auto-resuming on unlock and ignores stale generations",
  () =>
    Effect.gen(function* () {
      const reports = yield* Queue.unbounded<DesktopCuaSafetyReport>();
      const accepted = yield* Ref.make(Option.some(readinessFor(3)));
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const signals = yield* leases.subscribe;
        const authorityChanges: Array<{
          readonly kind: string;
          readonly threadId: ThreadId;
          readonly controlId: string;
          readonly terminal?: string;
        }> = [];
        const unsubscribe = leases.onAuthorityChange?.(
          (change) => void authorityChanges.push(change),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe?.()));

        const control = Option.getOrThrow(yield* leases.control(thread, Option.none()));
        yield* PubSub.take(signals);

        yield* Queue.offer(reports, {
          version: 1,
          type: "cuaSessionLock",
          generation: 2,
          locked: true,
          reasons: ["screen_locked"],
        });
        yield* Queue.offer(reports, readinessFor(3));
        yield* PubSub.take(signals);
        assert.equal(yield* PubSub.remaining(signals), 0);
        assert.equal((yield* leases.controlState(thread, control.controlId))._tag, "active");
        assert.deepEqual(authorityChanges, []);

        yield* Queue.offer(reports, {
          version: 1,
          type: "cuaSessionLock",
          generation: 3,
          locked: true,
          reasons: ["screen_locked"],
        });
        yield* PubSub.take(signals);
        assert.deepEqual(yield* leases.controlState(thread, control.controlId), {
          _tag: "paused",
          reason: "screen_locked",
        });
        assert.deepEqual(authorityChanges, [
          {
            kind: "pause",
            threadId: thread,
            controlId: control.controlId,
            terminal: "screen_locked",
          },
        ]);
        const refusedWhileLocked = yield* leases.callReservation(thread, {
          action: "reserve",
          controlId: control.controlId,
          connectionId: "driver:session-lock",
          callId: "read",
          interruptions: 0,
          idleEpoch: 0,
          name: "list_apps",
          args: {},
        });
        assert.equal(refusedWhileLocked.status, "refused");

        yield* Queue.offer(reports, {
          version: 1,
          type: "cuaSessionLock",
          generation: 3,
          locked: true,
          reasons: ["screen_locked", "system_suspended"],
        });
        yield* Queue.offer(reports, {
          version: 1,
          type: "cuaSessionLock",
          generation: 2,
          locked: false,
          reasons: [],
        });
        yield* Queue.offer(reports, {
          version: 1,
          type: "cuaSessionLock",
          generation: 3,
          locked: false,
          reasons: [],
        });
        yield* PubSub.take(signals);
        assert.deepEqual(yield* leases.controlState(thread, control.controlId), {
          _tag: "paused",
          reason: "screen_locked",
        });
        const refusedAfterUnlock = yield* leases.callReservation(thread, {
          action: "reserve",
          controlId: control.controlId,
          connectionId: "driver:session-lock",
          callId: "read-after-unlock",
          interruptions: 1,
          idleEpoch: 0,
          name: "list_apps",
          args: {},
        });
        assert.equal(refusedAfterUnlock.status, "refused");

        yield* leases.resume;
        yield* PubSub.take(signals);
        const resumed = yield* leases.controlState(thread, control.controlId);
        assert.equal(resumed._tag, "active");
        if (resumed._tag === "active") {
          assert.deepEqual(resumed.interruptions, { count: 1, last: "screen_locked" });
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ComputerUseLeases.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                database,
                NodeServices.layer,
                DesktopTelemetryReceiver.layerTest({
                  cuaSafety: Stream.fromQueue(reports),
                  cuaReadiness: Ref.get(accepted),
                }),
              ),
            ),
          ),
        ),
      );
    }),
);

it.effect(
  "clears host lock state on unlock before mint and pauses controls minted while locked",
  () =>
    Effect.gen(function* () {
      const reports = yield* Queue.unbounded<DesktopCuaSafetyReport>();
      const accepted = yield* Ref.make(Option.none<DesktopCuaReadinessReport>());
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const signals = yield* leases.subscribe;

        yield* Queue.offer(reports, {
          version: 1,
          type: "cuaSessionLock",
          generation: 1,
          locked: true,
          reasons: ["screensaver_active"],
        });
        yield* Queue.offer(reports, readinessFor(1));
        yield* PubSub.take(signals);
        yield* Queue.offer(reports, {
          version: 1,
          type: "cuaSessionLock",
          generation: 1,
          locked: false,
          reasons: [],
        });
        yield* PubSub.take(signals);

        const first = Option.getOrThrow(yield* leases.control(thread, Option.none()));
        yield* PubSub.take(signals);
        assert.equal((yield* leases.controlState(thread, first.controlId))._tag, "active");
        yield* leases.stop(thread);
        yield* PubSub.take(signals);

        yield* Queue.offer(reports, {
          version: 1,
          type: "cuaSessionLock",
          generation: 1,
          locked: true,
          reasons: ["session_deactivated"],
        });
        yield* Queue.offer(reports, readinessFor(1));
        yield* PubSub.take(signals);

        const second = Option.getOrThrow(yield* leases.control(thread, Option.none()));
        yield* PubSub.take(signals);
        assert.deepEqual(yield* leases.controlState(thread, second.controlId), {
          _tag: "paused",
          reason: "screen_locked",
        });

        yield* Queue.offer(reports, {
          version: 1,
          type: "cuaSessionLock",
          generation: 1,
          locked: false,
          reasons: [],
        });
        yield* PubSub.take(signals);
        assert.deepEqual(yield* leases.controlState(thread, second.controlId), {
          _tag: "paused",
          reason: "screen_locked",
        });

        yield* leases.resume;
        yield* PubSub.take(signals);
        assert.equal((yield* leases.controlState(thread, second.controlId))._tag, "active");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ComputerUseLeases.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                database,
                NodeServices.layer,
                DesktopTelemetryReceiver.layerTest({
                  cuaSafety: Stream.fromQueue(reports),
                  cuaReadiness: Ref.get(accepted),
                }),
              ),
            ),
          ),
        ),
      );
    }),
);

it.effect(
  "a Linux server that captures its own windows has live frames without a desktop helper",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      // Frames only: a person's input and secret fields still need a helper that reports them.
      assert.deepEqual(yield* leases.detection, {
        humanInput: false,
        privateMode: false,
        frames: true,
      });
    }).pipe(
      Effect.provide(
        ComputerUseLeases.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              database,
              NodeServices.layer,
              DesktopTelemetryReceiver.layerTest({}),
              Layer.succeed(
                LinuxFrameSource.LinuxFrameSource,
                LinuxFrameSource.LinuxFrameSource.of({
                  supported: Effect.succeed(true),
                  setTargets: () => Effect.void,
                  frames: Stream.empty,
                }),
              ),
            ),
          ),
        ),
      ),
    ),
);

// quarantine: #1695 private mode is switched off; re-enable with it
it.effect.skip(
  "follows the helper's reports: what it detects, and a secret field that pauses every agent until it loses focus",
  () =>
    Effect.gen(function* () {
      const reports = yield* Queue.unbounded<DesktopCuaSafetyReport>();
      // What the receiver accepted; it stores a report before publishing it.
      const accepted = yield* Ref.make(Option.none<DesktopCuaReadinessReport>());
      const readiness = (
        signals: DesktopCuaReadinessReport["signals"],
      ): DesktopCuaReadinessReport => ({
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
        signals,
      });
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const signals = yield* leases.subscribe;
        // Nothing reported yet: a host that never says it detects anything detects nothing.
        assert.deepEqual(yield* leases.detection, {
          humanInput: false,
          privateMode: false,
          frames: false,
        });
        const supported = readiness({ humanInput: "supported", privateMode: "supported" });
        yield* Ref.set(accepted, Option.some(supported));
        yield* Queue.offer(reports, supported);
        yield* PubSub.take(signals);
        assert.deepEqual(yield* leases.detection, {
          humanInput: true,
          privateMode: true,
          frames: false,
        });
        // A downgrade counts as soon as the receiver accepts it, before the report is consumed.
        yield* Ref.set(
          accepted,
          Option.some(readiness({ humanInput: "supported", privateMode: "unsupported" })),
        );
        assert.deepEqual(yield* leases.detection, {
          humanInput: true,
          privateMode: false,
          frames: false,
        });
        yield* Ref.set(accepted, Option.some(supported));
        // Frames count only when the helper itself says it sends them (#1370).
        yield* Ref.set(accepted, Option.some({ ...supported, frames: true }));
        assert.isTrue((yield* leases.detection).frames);
        yield* Ref.set(accepted, Option.some(supported));

        const control = Option.getOrThrow(yield* leases.control(thread, Option.none()));
        // The new control is announced to session lists first.
        yield* PubSub.take(signals);
        yield* Queue.offer(reports, {
          version: 1,
          type: "cuaPrivateMode",
          active: true,
          target: { pid: 7, windowId: 3 },
        });
        yield* PubSub.take(signals);
        assert.deepEqual(yield* leases.controlState(thread, control.controlId), {
          _tag: "paused",
          reason: "private",
        });
        yield* Queue.offer(reports, {
          version: 1,
          type: "cuaPrivateMode",
          active: false,
          target: { pid: 7, windowId: 3 },
        });
        yield* PubSub.take(signals);
        assert.equal((yield* leases.controlState(thread, control.controlId))._tag, "active");
        // A secret that comes and goes before anyone reads the control still counts as a pause.
        const before = yield* leases.controlState(thread, control.controlId);
        for (const active of [true, false])
          yield* Queue.offer(reports, {
            version: 1,
            type: "cuaPrivateMode",
            active,
            target: { pid: 7, windowId: 3 },
          });
        yield* PubSub.take(signals);
        yield* PubSub.take(signals);
        const after = yield* leases.controlState(thread, control.controlId);
        assert.equal(
          after._tag === "active" && before._tag === "active"
            ? after.interruptions.count - before.interruptions.count
            : -1,
          1,
        );
        assert.deepInclude(after, { interruptions: { count: 2, last: "private" } });
        // A person using the computer does not interrupt admitted agents.
        yield* Queue.offer(reports, { version: 1, type: "cuaHumanInput", source: "unknown" });
        assert.equal((yield* leases.controlState(thread, control.controlId))._tag, "active");
        // Only the thread's live control records a window; a replaced proxy's report changes nothing.
        assert.isFalse(yield* leases.setTarget(thread, "control:old", { pid: 9, windowId: 9 }));
        assert.isTrue(yield* leases.setTarget(thread, control.controlId, { pid: 7, windowId: 3 }));
        const recorded = (yield* leases.sessions).find(
          (entry) => entry.control.controlId === control.controlId,
        );
        assert.deepEqual(recorded?.control.target, { pid: 7, windowId: 3 });
        // The agent's cursor rides on the live control for the preview, and only there.
        const cursor = { windowId: 3, point: { fx: 0.25, fy: 0.5 }, phase: "acting" } as const;
        assert.isFalse(yield* leases.setTarget(thread, "control:old", { cursor }));
        assert.isTrue(yield* leases.setTarget(thread, control.controlId, { cursor }));
        const cursorOf = Effect.map(
          leases.sessions,
          (entries) =>
            entries.find((entry) => entry.control.controlId === control.controlId)?.control.cursor,
        );
        assert.deepEqual(yield* cursorOf, cursor);
        // Another window becomes the target: a point on the old one says nothing about it.
        assert.isTrue(yield* leases.setTarget(thread, control.controlId, { pid: 7, windowId: 4 }));
        assert.isUndefined(yield* cursorOf);
        // A cursor for a window that is not the target is not kept, and null clears it.
        assert.isTrue(yield* leases.setTarget(thread, control.controlId, { cursor }));
        assert.isUndefined(yield* cursorOf);
        yield* leases.setTarget(thread, control.controlId, { cursor: { ...cursor, windowId: 4 } });
        assert.deepEqual(yield* cursorOf, { ...cursor, windowId: 4 });
        assert.isTrue(yield* leases.setTarget(thread, control.controlId, { cursor: null }));
        assert.isUndefined(yield* cursorOf);
      }).pipe(
        Effect.provide(
          ComputerUseLeases.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                database,
                NodeServices.layer,
                DesktopTelemetryReceiver.layerTest({
                  cuaSafety: Stream.fromQueue(reports),
                  cuaReadiness: Ref.get(accepted),
                }),
              ),
            ),
          ),
        ),
      );
    }),
);
