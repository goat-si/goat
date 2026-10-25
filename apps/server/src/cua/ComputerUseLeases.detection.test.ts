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

it.effect(
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

        const control = yield* leases.control(thread, Option.none());
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
