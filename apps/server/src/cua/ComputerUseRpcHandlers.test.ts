import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  type DesktopCuaDriverReport,
  type DesktopCuaReadinessReport,
  type DesktopCuaSafetyReport,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as Handoffs from "../handoffs/Handoffs.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import { makeComputerUseRpcHandlers } from "./ComputerUseRpcHandlers.ts";

const readiness = {
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
} satisfies DesktopCuaReadinessReport;

it.effect(
  "invalidates host status for accepted readiness and driver reports, ignoring safety input",
  () =>
    Effect.gen(function* () {
      const safety = yield* PubSub.unbounded<DesktopCuaSafetyReport>();
      const reports = yield* PubSub.unbounded<DesktopCuaDriverReport>();
      const handlers = yield* makeComputerUseRpcHandlers(AuthSessionId.make("readiness-test")).pipe(
        Effect.provide(
          DesktopTelemetryReceiver.layerTest({
            cuaSafety: Stream.fromPubSub(safety),
            cuaReports: Stream.fromPubSub(reports),
          }),
        ),
      );
      const revisions = yield* Queue.unbounded<{ readonly revision: number }>();
      yield* handlers["computerUse.statusChanges"]({}).pipe(
        Stream.runForEach((value) => Queue.offer(revisions, value)),
        Effect.forkChild,
      );
      expect(yield* Queue.take(revisions)).toEqual({ revision: 0 });

      // The receiver publishes only accepted generations to cuaSafety.
      yield* PubSub.publish(safety, { version: 1, type: "cuaHumanInput", source: "keyboard" });
      yield* PubSub.publish(safety, {
        version: 1,
        type: "cuaPrivateMode",
        active: true,
        target: { pid: 1, windowId: 2 },
      });
      yield* PubSub.publish(safety, readiness);
      expect(yield* Queue.take(revisions)).toEqual({ revision: 1 });
      yield* PubSub.publish(safety, { ...readiness, generation: 2 });
      expect(yield* Queue.take(revisions)).toEqual({ revision: 2 });

      yield* PubSub.publish(reports, {
        version: 1,
        type: "cuaDriverReport",
        requestId: "driver-start",
        status: "ready",
        mcp: { command: "/driver", args: [], environment: [] },
      });
      expect(yield* Queue.take(revisions)).toEqual({ revision: 3 });
      yield* PubSub.publish(reports, {
        version: 1,
        type: "cuaDriverReport",
        requestId: "driver-stop",
        status: "stopped",
      });
      expect(yield* Queue.take(revisions)).toEqual({ revision: 4 });
      yield* PubSub.publish(reports, {
        version: 1,
        type: "cuaDriverReport",
        requestId: "driver-failed",
        status: "unavailable",
      });
      expect(yield* Queue.take(revisions)).toEqual({ revision: 5 });
    }).pipe(Effect.provide(Layer.mock(Handoffs.Handoffs)({})), Effect.scoped),
);

it.effect("emits only the initial status revision when desktop telemetry is absent", () =>
  Effect.gen(function* () {
    const handlers = yield* makeComputerUseRpcHandlers(AuthSessionId.make("headless-test"));
    expect(yield* Stream.runCollect(handlers["computerUse.statusChanges"]({}))).toEqual([
      { revision: 0 },
    ]);
  }).pipe(Effect.provide(Layer.mock(Handoffs.Handoffs)({}))),
);
