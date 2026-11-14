import {
  TailscaleCommandExitError,
  disableTailscaleServe,
  ensureTailscaleServe,
  findExcludedRange,
  readWindowsExcludedTcpPortRanges,
  reservedPortMessage,
  suggestFreePort,
} from "@goat/tailscale";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { loopbackUrlHostForAddress } from "../startupAccess.ts";

const isTailscaleCommandExitError = Schema.is(TailscaleCommandExitError);

export interface TailscaleServeTarget {
  readonly localPort: number;
  readonly servePort: number;
  readonly localHost: string;
}

interface TailscaleServeStartupBase {
  readonly enabled: boolean;
  readonly servePort: number;
  readonly parked: Deferred.Deferred<void>;
  readonly awaitActivation: Effect.Effect<void>;
}

const serveRetrySchedule = Schedule.exponential("2 seconds").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(60))),
  ),
);

const openTailscaleServe = Effect.fn("TailscaleServeStartup.open")(function* <
  E,
  R,
  E2,
  R2,
  R3,
>(input: {
  readonly servePort: number;
  readonly parked: Deferred.Deferred<void>;
  readonly awaitActivation: Effect.Effect<void>;
  readonly ensure: (target: TailscaleServeTarget) => Effect.Effect<void, E, R>;
  readonly disable: (request: { readonly servePort: number }) => Effect.Effect<void, E2, R2>;
  readonly excludedRange?: (
    servePort: number,
  ) => Effect.Effect<
    { readonly start: number; readonly end: number; readonly suggestion: number | null } | null,
    never,
    R3
  >;
}) {
  return yield* Effect.acquireRelease(
    Effect.gen(function* () {
      yield* Deferred.succeed(input.parked, undefined).pipe(Effect.orDie);
      yield* input.awaitActivation;
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      if (typeof address === "string" || !("port" in address)) {
        return null;
      }

      const localPort = address.port;
      const target = {
        localPort,
        servePort: input.servePort,
        localHost: loopbackUrlHostForAddress(address),
      };
      const reserved = yield* (input.excludedRange ?? (() => Effect.succeed(null)))(
        input.servePort,
      );
      if (reserved !== null) {
        yield* Effect.logWarning(
          `${reservedPortMessage(
            input.servePort,
            { start: reserved.start, end: reserved.end },
            reserved.suggestion,
          )} Change it in Settings → Connections, or pass --tailscale-serve-port.`,
          { servePort: input.servePort },
        );
        return null;
      }
      const attempted = yield* Ref.make(false);
      const attempts = yield* Ref.make(0);
      const fiber = yield* Effect.gen(function* () {
        const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);
        yield* Ref.set(attempted, true);
        yield* input.ensure(target);
        yield* Effect.logInfo("Tailscale Serve configured", {
          localPort,
          servePort: input.servePort,
          attempts: attempt,
        });
      }).pipe(
        Effect.tapError((cause) =>
          Ref.get(attempts).pipe(
            Effect.flatMap((attempt) => {
              const log = attempt <= 1 ? Effect.logWarning : Effect.logDebug;
              const message =
                isTailscaleCommandExitError(cause) &&
                cause.stderrDiagnostic === "unsupported-target"
                  ? `Tailscale Serve cannot proxy to ${target.localHost}; bind --host 127.0.0.1 or 0.0.0.0 instead`
                  : "Failed to configure Tailscale Serve; retrying";
              return log(message, {
                cause,
                localPort,
                servePort: input.servePort,
              });
            }),
          ),
        ),
        Effect.retry(serveRetrySchedule),
        Effect.forkScoped({ startImmediately: true }),
      );
      return { fiber, attempted, servePort: input.servePort };
    }),
    (attempt) => {
      if (attempt === null) return Effect.void;
      // Interrupt first: an in-flight `tailscale serve` can still install the route.
      return Fiber.interrupt(attempt.fiber).pipe(
        Effect.flatMap(() => Ref.get(attempt.attempted)),
        Effect.flatMap((started) =>
          started
            ? input.disable({ servePort: attempt.servePort }).pipe(
                Effect.tap(() =>
                  Effect.logInfo("Tailscale Serve disabled", {
                    servePort: attempt.servePort,
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to disable Tailscale Serve", {
                    cause,
                    servePort: attempt.servePort,
                  }),
                ),
              )
            : Effect.void,
        ),
      );
    },
  );
});

export const layerTailscaleServeStartupWith = <E, R, E2, R2, R3 = never>(
  input: TailscaleServeStartupBase & {
    readonly ensure: (target: TailscaleServeTarget) => Effect.Effect<void, E, R>;
    readonly disable: (request: { readonly servePort: number }) => Effect.Effect<void, E2, R2>;
    readonly excludedRange?: (
      servePort: number,
    ) => Effect.Effect<
      { readonly start: number; readonly end: number; readonly suggestion: number | null } | null,
      never,
      R3
    >;
  },
) => (input.enabled ? Layer.effectDiscard(openTailscaleServe(input)) : Layer.empty);

export const layerTailscaleServeStartup = (input: TailscaleServeStartupBase) =>
  layerTailscaleServeStartupWith({
    ...input,
    ensure: (target) => ensureTailscaleServe(target),
    disable: (request) => disableTailscaleServe(request),
    excludedRange: (servePort) =>
      readWindowsExcludedTcpPortRanges().pipe(
        Effect.map((ranges) => {
          const range = findExcludedRange(servePort, ranges);
          return range === null
            ? null
            : {
                start: range.start,
                end: range.end,
                suggestion: suggestFreePort(servePort, ranges),
              };
        }),
      ),
  });
