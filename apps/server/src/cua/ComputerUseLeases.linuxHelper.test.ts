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
import * as LinuxHelperHost from "./linuxHelperHost/LinuxHelperHost.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const thread = ThreadId.make("thread-person");

// quarantine: #1695 private mode is switched off; re-enable with it
it.effect.skip(
  "a standalone Linux server's own helper: its signals count as detected, it watches while an agent controls the host, and its secret field pauses",
  () =>
    Effect.gen(function* () {
      const reports = yield* Queue.unbounded<DesktopCuaSafetyReport>();
      const watching = yield* Queue.unbounded<boolean>();
      const helperReport = yield* Ref.make(Option.none<DesktopCuaReadinessReport>());
      const liveReport = yield* Ref.make(Option.none<DesktopCuaReadinessReport>());
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const leases = yield* ComputerUseLeases.ComputerUseLeases;
        const signals = yield* leases.subscribe;
        assert.deepEqual(yield* leases.detection, {
          humanInput: false,
          privateMode: false,
          frames: false,
        });
        const report: DesktopCuaReadinessReport = {
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
          signals: { humanInput: "supported", privateMode: "supported" },
        };
        // A check before the first turn proves setup, but no helper watches yet (#1542).
        yield* Ref.set(helperReport, Option.some(report));
        assert.deepEqual(yield* leases.detection, {
          humanInput: false,
          privateMode: false,
          frames: false,
        });
        yield* Ref.set(liveReport, Option.some(report));
        // No desktop host reports, so the server's own helper speaks for the host.
        assert.deepEqual(yield* leases.detection, {
          humanInput: true,
          privateMode: true,
          frames: false,
        });
        assert.isFalse(yield* Queue.take(watching));
        const control = yield* leases.control(thread, Option.none());
        yield* PubSub.take(signals);
        assert.isTrue(yield* Queue.take(watching));
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
      }).pipe(
        Effect.provide(
          ComputerUseLeases.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                database,
                NodeServices.layer,
                DesktopTelemetryReceiver.layerTest({}),
                Layer.succeed(
                  LinuxHelperHost.LinuxHelperHost,
                  LinuxHelperHost.LinuxHelperHost.of({
                    readiness: Ref.get(helperReport),
                    liveReadiness: Ref.get(liveReport),
                    safety: Stream.fromQueue(reports),
                    setWatch: (active) => Queue.offer(watching, active).pipe(Effect.asVoid),
                  }),
                ),
              ),
            ),
          ),
        ),
      );
    }),
);
