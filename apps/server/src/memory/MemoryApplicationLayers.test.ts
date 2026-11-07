import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ServerActivation } from "../serverActivation.ts";
import * as Application from "./MemoryApplicationLayers.ts";
import * as Worker from "./MemoryWorker.ts";
import * as Reports from "./MemoryReportWorker.ts";

it.effect("starts reports after activation and releases their scope on close", () =>
  Effect.gen(function* () {
    const log: string[] = [];
    const gate = yield* Deferred.make<void>();
    const services = Layer.mergeAll(
      Layer.mock(Worker.MemoryWorker)({
        start: () =>
          Effect.sync(() => {
            log.push("worker-start");
          }),
      }),
      Layer.mock(Reports.MemoryReportWorker)({
        start: () =>
          Effect.sync(() => {
            log.push("report-start");
          }).pipe(
            Effect.andThen(
              Effect.addFinalizer(() =>
                Effect.sync(() => {
                  log.push("report-finalizer");
                }),
              ),
            ),
          ),
      }),
    );
    const startLayer = Application.layerStartWorkers;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(startLayer.pipe(Layer.provide(services)));
        yield* TestClock.adjust(0);
        assert.deepStrictEqual(log, ["worker-start"]);
        yield* Deferred.succeed(gate, undefined);
        yield* TestClock.adjust(0);
        assert.deepStrictEqual(log, ["worker-start", "report-start"]);
      }).pipe(Effect.provideService(ServerActivation, Deferred.await(gate))),
    );
    assert.deepStrictEqual(log, ["worker-start", "report-start", "report-finalizer"]);
  }),
);
