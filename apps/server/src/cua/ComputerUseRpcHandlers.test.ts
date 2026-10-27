import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  type DesktopCuaDriverReport,
  type DesktopCuaReadinessReport,
  type DesktopCuaSafetyReport,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as Handoffs from "../handoffs/Handoffs.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import { makeComputerUseRpcHandlers } from "./ComputerUseRpcHandlers.ts";
import * as ComputerUseAgentConnections from "./ComputerUseAgentConnections.ts";

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

it.effect(
  "coalesces a blocked status consumer to one current revision and releases all sources on cancellation",
  () =>
    Effect.gen(function* () {
      const connections = yield* ComputerUseAgentConnections.make;
      const subscribed = yield* Deferred.make<PubSub.Subscription<void>>();
      const blocked = yield* Deferred.make<void>();
      const produce = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const readinessDrained = yield* Deferred.make<void>();
      const reportsDrained = yield* Deferred.make<void>();
      const readinessClosed = yield* Deferred.make<void>();
      const reportsClosed = yield* Deferred.make<void>();
      const received = yield* Deferred.make<ReadonlyArray<{ readonly revision: number }>>();
      let generation = 0;
      let reportCount = 0;
      const safety = Stream.unwrap(
        Deferred.await(produce).pipe(
          Effect.as(
            Stream.fromIterable(
              Array.from({ length: 1000 }, (_, index) => ({ ...readiness, generation: index + 1 })),
            ).pipe(
              Stream.tap((report) =>
                Effect.sync(() => {
                  generation = report.generation;
                }),
              ),
              Stream.concat(
                Stream.fromEffect(Deferred.succeed(readinessDrained, undefined)).pipe(Stream.drain),
              ),
              Stream.concat(Stream.never),
            ),
          ),
        ),
      ).pipe(Stream.ensuring(Deferred.succeed(readinessClosed, undefined)));
      const reports = Stream.unwrap(
        Deferred.await(produce).pipe(
          Effect.as(
            Stream.fromIterable(
              Array.from({ length: 1000 }, (_, index): DesktopCuaDriverReport => ({
                version: 1,
                type: "cuaDriverReport",
                requestId: `driver-${index}`,
                status: "stopped",
              })),
            ).pipe(
              Stream.tap(() =>
                Effect.sync(() => {
                  reportCount++;
                }),
              ),
              Stream.concat(
                Stream.fromEffect(Deferred.succeed(reportsDrained, undefined)).pipe(Stream.drain),
              ),
              Stream.concat(Stream.never),
            ),
          ),
        ),
      ).pipe(Stream.ensuring(Deferred.succeed(reportsClosed, undefined)));
      const handlers = yield* makeComputerUseRpcHandlers(
        AuthSessionId.make("slow-status-test"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            DesktopTelemetryReceiver.layerTest({ cuaSafety: safety, cuaReports: reports }),
            Layer.succeed(ComputerUseAgentConnections.ComputerUseAgentConnections, {
              ...connections,
              changes: connections.changes.pipe(
                Effect.tap((subscription) => Deferred.succeed(subscribed, subscription)),
              ),
            }),
          ),
        ),
      );
      const consumer = yield* Effect.gen(function* () {
        const pull = yield* Stream.toPull(handlers["computerUse.statusChanges"]({}));
        expect(yield* pull).toEqual([{ revision: 0 }]);
        yield* Deferred.succeed(blocked, undefined);
        yield* Deferred.await(resume);
        yield* Deferred.succeed(received, yield* pull);
        yield* Effect.never;
      }).pipe(Effect.scoped, Effect.forkScoped);
      yield* Deferred.await(blocked);
      for (let count = 0; count < 50; count++) {
        for (let ending = 0; ending < ComputerUseAgentConnections.FAILING_AFTER; ending++) {
          yield* connections.report({ reason: "helper_restarted" });
        }
        yield* connections.report(false);
      }
      yield* Deferred.succeed(produce, undefined);
      yield* Deferred.await(readinessDrained);
      yield* Deferred.await(reportsDrained);
      expect(generation).toBe(1000);
      expect(reportCount).toBe(1000);
      expect(yield* connections.failure).toBeUndefined();
      yield* Deferred.succeed(resume, undefined);
      expect(yield* Deferred.await(received)).toEqual([{ revision: 1 }]);
      yield* Fiber.interrupt(consumer);
      expect(yield* Deferred.isDone(readinessClosed)).toBe(true);
      expect(yield* Deferred.isDone(reportsClosed)).toBe(true);
      expect(Latch.isOpen((yield* Deferred.await(subscribed)).shutdownHook)).toBe(true);
    }).pipe(Effect.provide(Layer.mock(Handoffs.Handoffs)({})), Effect.scoped),
);
