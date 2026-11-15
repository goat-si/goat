import {
  TailscaleCommandExitError,
  TailscaleStatusParseError,
  disableTailscaleServe,
  ensureTailscaleServe,
  findExcludedRange,
  readTailscaleServeRootHolders,
  readWindowsExcludedTcpPortRanges,
  reservedPortMessage,
  suggestFreePort,
} from "@goat/tailscale";
import * as NetService from "@goat/shared/Net";
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
const isTailscaleStatusParseError = Schema.is(TailscaleStatusParseError);

export interface TailscaleServeTarget {
  readonly localPort: number;
  readonly servePort: number;
  readonly localHost: string;
}

/** Who holds the Serve port's root: nobody, this server, only dead loopback ports, or another live one. */
export type TailscaleServeRootHolderState = "none" | "ours" | "dead" | "other";

const readRootHolder = Effect.fn("TailscaleServeStartup.readRootHolder")(function* (
  servePort: number,
  target: { readonly host: string; readonly port: number },
) {
  const net = yield* NetService.NetService;
  const holders = yield* readTailscaleServeRootHolders(servePort, target);
  if (holders.length === 0) return "none" as const;
  if (holders.some((holder) => holder.ours)) return "ours" as const;
  const live = yield* Effect.forEach(holders, (holder) =>
    holder.ours || holder.loopback === undefined
      ? Effect.succeed(true)
      : net.hasListenerOnHost(holder.loopback.port, holder.loopback.host),
  );
  return live.includes(true) ? ("other" as const) : ("dead" as const);
});

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
  E4,
  R4,
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
  readonly rootHolder?: (target: {
    readonly host: string;
    readonly port: number;
  }) => Effect.Effect<TailscaleServeRootHolderState, E4, R4>;
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
      const holderOf = input.rootHolder ?? (() => Effect.succeed("none" as const));
      const at = { host: target.localHost.replace(/^\[|\]$/gu, ""), port: localPort };
      const reads = yield* Ref.make(0);
      // Tailscale may not answer yet at login, so read until it does, as apply retries; a
      // status it printed but that cannot be parsed stays unreadable.
      const readHolder = holderOf(at).pipe(
        Effect.tapError((cause) =>
          isTailscaleStatusParseError(cause)
            ? Effect.void
            : Ref.updateAndGet(reads, (count) => count + 1).pipe(
                Effect.flatMap((read) =>
                  (read <= 1 ? Effect.logWarning : Effect.logDebug)(
                    "Could not read Tailscale Serve status; retrying",
                    { cause, localPort, servePort: input.servePort },
                  ),
                ),
              ),
        ),
        Effect.retry({
          schedule: serveRetrySchedule,
          while: (cause) => !isTailscaleStatusParseError(cause),
        }),
        Effect.orElseSucceed(() => "unreadable" as const),
      );
      const apply = Effect.gen(function* () {
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
      );
      const initial = Effect.gen(function* () {
        const holder = yield* readHolder;
        // Another live server's route, or one we cannot parse, is not ours to replace or turn off.
        if (holder === "other" || holder === "unreadable") {
          return yield* Effect.logWarning(
            holder === "other"
              ? "Tailscale Serve left off; its port already serves another server or app"
              : "Tailscale Serve left off; its current routes could not be parsed",
            { localPort, servePort: input.servePort },
          );
        }
        yield* apply;
      });
      // Startup is not the only time a route goes stale: whoever finds it on a dead port takes it back.
      const repair = Effect.sleep("30 seconds").pipe(
        Effect.andThen(holderOf(at)),
        Effect.flatMap((holder) =>
          holder === "dead"
            ? Ref.set(attempted, true).pipe(
                Effect.andThen(input.ensure(target)),
                Effect.andThen(
                  Effect.logInfo("Tailscale Serve repaired", {
                    localPort,
                    servePort: input.servePort,
                  }),
                ),
              )
            : Effect.void,
        ),
        Effect.ignore,
        Effect.forever,
      );
      const fiber = yield* initial.pipe(
        Effect.andThen(repair),
        Effect.forkScoped({ startImmediately: true }),
      );
      // At stop, only a route still ours is turned off; one another server took over stays.
      const stillOurs =
        input.rootHolder === undefined
          ? Effect.succeed(true)
          : holderOf(at).pipe(
              Effect.map((holder) => holder === "ours"),
              Effect.orElseSucceed(() => false),
            );
      return { fiber, attempted, stillOurs, servePort: input.servePort };
    }),
    (attempt) => {
      if (attempt === null) return Effect.void;
      // Interrupt first: an in-flight `tailscale serve` can still install the route.
      return Fiber.interrupt(attempt.fiber).pipe(
        Effect.flatMap(() => Ref.get(attempt.attempted)),
        Effect.flatMap((started) => (started ? attempt.stillOurs : Effect.succeed(false))),
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

export const layerTailscaleServeStartupWith = <E, R, E2, R2, R3 = never, E4 = never, R4 = never>(
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
    readonly rootHolder?: (target: {
      readonly host: string;
      readonly port: number;
    }) => Effect.Effect<TailscaleServeRootHolderState, E4, R4>;
  },
) => (input.enabled ? Layer.effectDiscard(openTailscaleServe(input)) : Layer.empty);

export const layerTailscaleServeStartup = (input: TailscaleServeStartupBase) =>
  layerTailscaleServeStartupWith({
    ...input,
    ensure: (target) => ensureTailscaleServe(target),
    disable: (request) => disableTailscaleServe(request),
    rootHolder: (target) =>
      readRootHolder(input.servePort, target).pipe(Effect.provide(NetService.layer)),
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
