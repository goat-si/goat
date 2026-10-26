import * as NodeNet from "node:net";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Predicate from "effect/Predicate";

export class NetError extends Data.TaggedError("NetError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const isErrnoExceptionWithCode = (
  cause: unknown,
): cause is {
  readonly code: string;
} =>
  Predicate.isObject(cause) &&
  Predicate.hasProperty(cause, "code") &&
  Predicate.isString(cause.code);

const closeServer = (server: NodeNet.Server) => {
  try {
    server.close();
  } catch {}
};

export interface NetServiceShape {
  readonly canListenOnHost: (port: number, host: string) => Effect.Effect<boolean>;

  readonly isPortAvailableOnLoopback: (port: number) => Effect.Effect<boolean>;

  readonly hasListenerOnHost: (port: number, host: string) => Effect.Effect<boolean>;

  readonly reserveLoopbackPort: (host?: string) => Effect.Effect<number, NetError>;

  readonly findAvailablePort: (preferred: number) => Effect.Effect<number, NetError>;
}

export class NetService extends Context.Service<NetService, NetServiceShape>()(
  "@goat/shared/Net/NetService",
) {}

/** @public */
export const make = () => {
  const canListenOnHost = (port: number, host: string): Effect.Effect<boolean> =>
    Effect.callback<boolean>((resume) => {
      const server = NodeNet.createServer();
      let settled = false;

      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        resume(Effect.succeed(value));
      };

      server.unref();

      server.once("error", (cause) => {
        // Missing IPv6 addresses or kernel support do not mean the port is occupied.
        if (
          isErrnoExceptionWithCode(cause) &&
          (cause.code === "EADDRNOTAVAIL" || cause.code === "EAFNOSUPPORT")
        ) {
          settle(true);
          return;
        }
        settle(false);
      });

      server.once("listening", () => {
        server.close(() => {
          settle(true);
        });
      });

      server.listen({ host, port });

      return Effect.sync(() => {
        closeServer(server);
      });
    });

  const hasListenerOnHost = (port: number, host: string): Effect.Effect<boolean> =>
    Effect.callback<boolean>((resume) => {
      const socket = NodeNet.createConnection({ host, port });
      let settled = false;

      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resume(Effect.succeed(value));
      };

      socket.unref();
      socket.setTimeout(250);
      socket.once("connect", () => {
        settle(true);
      });
      socket.once("error", () => {
        settle(false);
      });
      socket.once("timeout", () => {
        settle(false);
      });

      return Effect.sync(() => {
        socket.destroy();
      });
    });

  const isPortAvailableOnLoopback = Effect.fn("Net.isPortAvailableOnLoopback")(function* (
    port: number,
  ): Effect.fn.Return<boolean> {
    const hasListener = yield* Effect.zipWith(
      hasListenerOnHost(port, "127.0.0.1"),
      hasListenerOnHost(port, "::1"),
      (ipv4, ipv6) => ipv4 || ipv6,
    );
    if (hasListener) {
      return false;
    }

    return yield* Effect.zipWith(
      canListenOnHost(port, "127.0.0.1"),
      canListenOnHost(port, "::1"),
      (ipv4, ipv6) => ipv4 && ipv6,
    );
  });

  // listen(0) then close races the next binder. Rebind exclusively and retry so a stolen
  // port is not returned. The socket is still closed before the caller binds.
  const bindLoopback = (
    port: number,
    host: string,
    exclusive: boolean,
  ): Effect.Effect<number, NetError> =>
    Effect.callback<number, NetError>((resume) => {
      const probe = NodeNet.createServer();
      let settled = false;

      const settle = (effect: Effect.Effect<number, NetError>) => {
        if (settled) return;
        settled = true;
        resume(effect);
      };

      probe.once("error", (cause) => {
        closeServer(probe);
        settle(Effect.fail(new NetError({ message: "Failed to reserve loopback port", cause })));
      });

      const listening = () => {
        const address = probe.address();
        const chosen = typeof address === "object" && address !== null ? address.port : 0;
        probe.close(() => {
          if (chosen > 0) {
            settle(Effect.succeed(chosen));
            return;
          }
          settle(Effect.fail(new NetError({ message: "Failed to reserve loopback port" })));
        });
      };

      if (exclusive) probe.listen({ host, port, exclusive: true }, listening);
      else probe.listen(port, host, listening);

      return Effect.sync(() => {
        closeServer(probe);
      });
    });

  const reserveLoopbackPort = (host = "127.0.0.1"): Effect.Effect<number, NetError> =>
    Effect.gen(function* () {
      let cause: NetError | undefined;
      for (let attempt = 0; attempt < 32; attempt++) {
        const probed = yield* bindLoopback(0, host, false).pipe(
          Effect.catch((error) => {
            cause = error;
            return Effect.succeed(0);
          }),
        );
        if (probed <= 0) continue;
        const claimed = yield* bindLoopback(probed, host, true).pipe(
          Effect.as(true),
          Effect.catch((error) => {
            cause = error;
            return Effect.succeed(false);
          }),
        );
        if (claimed) return probed;
      }
      return yield* cause ?? new NetError({ message: "Failed to reserve loopback port" });
    });

  return {
    canListenOnHost,
    isPortAvailableOnLoopback,
    hasListenerOnHost,
    reserveLoopbackPort,
    findAvailablePort: Effect.fn("Net.findAvailablePort")(function* (preferred) {
      if (preferred > 0 && (yield* isPortAvailableOnLoopback(preferred))) {
        return preferred;
      }
      return yield* reserveLoopbackPort();
    }),
  } satisfies NetServiceShape;
};

export const layer = Layer.sync(NetService, make);
