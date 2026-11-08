import { disableTailscaleServe, ensureTailscaleServe } from "@goat/tailscale";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as Layer from "effect/Layer";

import { loopbackUrlHostForAddress } from "../startupAccess.ts";

export interface TailscaleServeTarget {
  readonly localPort: number;
  readonly servePort: number;
  readonly localHost: string;
}

interface ConfiguredTailscaleServe {
  readonly localPort: number;
  readonly servePort: number;
}

interface TailscaleServeStartupBase {
  readonly enabled: boolean;
  readonly servePort: number;
  readonly parked: Deferred.Deferred<void>;
  readonly awaitActivation: Effect.Effect<void>;
}

const openTailscaleServe = Effect.fn("TailscaleServeStartup.open")(function* <E, R, E2, R2>(input: {
  readonly servePort: number;
  readonly parked: Deferred.Deferred<void>;
  readonly awaitActivation: Effect.Effect<void>;
  readonly ensure: (target: TailscaleServeTarget) => Effect.Effect<void, E, R>;
  readonly disable: (request: { readonly servePort: number }) => Effect.Effect<void, E2, R2>;
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
      return yield* input.ensure(target).pipe(
        Effect.as({ localPort, servePort: input.servePort } satisfies ConfiguredTailscaleServe),
        Effect.tap(() =>
          Effect.logInfo("Tailscale Serve configured", {
            localPort,
            servePort: input.servePort,
          }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to configure Tailscale Serve", {
            cause,
            localPort,
            servePort: input.servePort,
          }).pipe(Effect.as(null)),
        ),
      );
    }),
    (configured) =>
      configured
        ? input.disable({ servePort: configured.servePort }).pipe(
            Effect.tap(() =>
              Effect.logInfo("Tailscale Serve disabled", {
                servePort: configured.servePort,
              }),
            ),
            Effect.catch((cause) =>
              Effect.logWarning("Failed to disable Tailscale Serve", {
                cause,
                servePort: configured.servePort,
              }),
            ),
          )
        : Effect.void,
  );
});

export function layerTailscaleServeStartup(
  input: TailscaleServeStartupBase,
): Layer.Layer<never, never, HttpServer.HttpServer | ChildProcessSpawner.ChildProcessSpawner>;
export function layerTailscaleServeStartup<E, R, E2, R2>(
  input: TailscaleServeStartupBase & {
    readonly ensure: (target: TailscaleServeTarget) => Effect.Effect<void, E, R>;
    readonly disable: (request: { readonly servePort: number }) => Effect.Effect<void, E2, R2>;
  },
): Layer.Layer<never, never, HttpServer.HttpServer | R | R2>;
export function layerTailscaleServeStartup<E, R, E2, R2>(
  input: TailscaleServeStartupBase & {
    readonly ensure?: (target: TailscaleServeTarget) => Effect.Effect<void, E, R>;
    readonly disable?: (request: { readonly servePort: number }) => Effect.Effect<void, E2, R2>;
  },
) {
  if (!input.enabled) return Layer.empty;
  const startup = {
    servePort: input.servePort,
    parked: input.parked,
    awaitActivation: input.awaitActivation,
  };
  if (input.ensure !== undefined && input.disable !== undefined) {
    return Layer.effectDiscard(
      openTailscaleServe({ ...startup, ensure: input.ensure, disable: input.disable }),
    );
  }
  if (input.ensure !== undefined) {
    return Layer.effectDiscard(
      openTailscaleServe({
        ...startup,
        ensure: input.ensure,
        disable: (request) => disableTailscaleServe(request),
      }),
    );
  }
  if (input.disable !== undefined) {
    return Layer.effectDiscard(
      openTailscaleServe({
        ...startup,
        ensure: (target) => ensureTailscaleServe(target),
        disable: input.disable,
      }),
    );
  }
  return Layer.effectDiscard(
    openTailscaleServe({
      ...startup,
      ensure: (target) => ensureTailscaleServe(target),
      disable: (request) => disableTailscaleServe(request),
    }),
  );
}
