import type { CuaDriverMcpConfiguration } from "@goat/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import type * as CuaDisplay from "./CuaDisplayCapability.ts";
import type { CuaDriverHost } from "./CuaDriver.ts";
import { CuaDriverHostError, type CuaDriverError } from "./CuaDriverErrors.ts";
import { desktopStopAcknowledged } from "./CuaDriverStop.ts";

export const makeDesktopHostFactory = Effect.fn("CuaDriver.makeDesktopHostFactory")(function* () {
  const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const crypto = yield* Crypto.Crypto;
  // The desktop app runs in the signed-in session and starts the driver with its own environment.
  return (_display: ReadonlyArray<CuaDisplay.CuaDisplayVariable>) =>
    Effect.gen(function* () {
      const requestId = yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError((cause) => new CuaDriverHostError({ operation: "desktop", cause })));
      const scope = yield* Scope.make();
      const ready = yield* Deferred.make<CuaDriverMcpConfiguration, CuaDriverError>();
      const stopped = yield* Deferred.make<void, CuaDriverError>();
      let generation: number | undefined;
      let readyReported = false;
      let stoppedGeneration: number | undefined;
      let stoppedReported = false;
      let requested = false;
      let retired = false;
      const unavailable = new CuaDriverHostError({ operation: "desktop" });
      const retire = (error: CuaDriverError) =>
        Deferred.fail(ready, error).pipe(Effect.andThen(Deferred.fail(stopped, error)));
      const lost = Deferred.fail(ready, unavailable).pipe(
        Effect.andThen(Deferred.succeed(stopped, undefined)),
      );
      const start = Effect.gen(function* () {
        // Start the subscription before writing: the desktop may reply synchronously.
        yield* receiver.cuaReports.pipe(
          Stream.runForEach((report) =>
            Effect.gen(function* () {
              if (report.requestId !== requestId) return;
              if (report.status === "ready") {
                if (!readyReported) generation = report.hostGeneration;
                readyReported = true;
                yield* Deferred.succeed(ready, report.mcp);
              } else if (report.status === "stopped") {
                if (!stoppedReported) stoppedGeneration = report.hostGeneration;
                stoppedReported = true;
                yield* retire(new CuaDriverHostError({ operation: "restart" }));
              } else
                yield* retire(
                  report.message === undefined && report.block === undefined
                    ? unavailable
                    : new CuaDriverHostError({
                        operation: "desktop",
                        ...(report.message === undefined ? {} : { cause: report.message }),
                        ...(report.block === undefined ? {} : { block: report.block }),
                      }),
                );
            }),
          ),
          Effect.ensuring(lost),
          Effect.forkIn(scope, { startImmediately: true }),
        );
        const health = yield* receiver.subscribeHealth.pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        if (health.latest.status === "unavailable" || health.latest.status === "stopped")
          return yield* unavailable;
        yield* health.changes.pipe(
          Stream.runForEach((value) =>
            value.status === "stopped" || value.status === "unavailable" ? lost : Effect.void,
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        );
        if (retired) return yield* unavailable;
        requested = true;
        yield* receiver
          .requestCuaDriver(requestId, true)
          .pipe(
            Effect.mapError((cause) => new CuaDriverHostError({ operation: "desktop", cause })),
          );
        return yield* Deferred.await(ready);
      });
      const stop = Effect.gen(function* () {
        retired = true;
        if (!requested) return;
        yield* receiver
          .requestCuaDriver(requestId, false)
          .pipe(
            Effect.mapError((cause) => new CuaDriverHostError({ operation: "desktop", cause })),
          );
        if (!(yield* desktopStopAcknowledged(stopped)))
          return yield* new CuaDriverHostError({ operation: "stop" });
      }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
      return {
        start,
        stop,
        waitForExit: Deferred.await(stopped),
        hostGeneration: () => generation,
        stoppedGeneration: () => stoppedGeneration,
      } satisfies CuaDriverHost;
    });
});
