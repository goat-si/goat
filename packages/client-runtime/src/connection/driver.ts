import type { DesktopSshPreparationProgress } from "@goat/contracts";
import { GOAT_CONNECT_COMING_SOON } from "@goat/shared/goatConnect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import type {
  ConnectionAttemptError,
  ConnectionAttemptIdentity,
  ConnectionAttemptStage,
  PreparedConnection,
} from "./model.ts";
import { ConnectionBlockedError, ConnectionTransientError } from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import {
  connectionRouteId,
  connectionRoutes,
  isConnectionRouteEnabled,
  routeEntry,
  routeHttpBaseUrl,
  sendsTokenInClear,
  usableRoutes,
} from "./routes.ts";
import * as RpcSession from "../rpc/session.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { withSshConnectionTiming } from "./sshTiming.ts";

export type ConnectionDriverProgress =
  | {
      readonly stage: "preparing";
      readonly hostAnswered?: true;
      readonly sshPreparation?: DesktopSshPreparationProgress;
      readonly routeId?: string;
    }
  | {
      readonly stage: Exclude<ConnectionAttemptStage, "preparing">;
      readonly prepared: PreparedConnection;
      readonly routeId?: string;
    };

export interface EnvironmentConnectionLease {
  readonly prepared: PreparedConnection;
  readonly session: RpcSession.RpcSession;
}

export type RouteCheck = "answered" | "silent" | "unchecked";

const ROUTE_CHECK_TIMEOUT_MS = 2_500;

export class ConnectionDriver extends Context.Service<
  ConnectionDriver,
  {
    readonly connect: (
      entry: ConnectionCatalogEntry,
      reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
      attemptContext?: Omit<ConnectionAttemptIdentity, "routeId">,
    ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, Scope.Scope>;
    readonly checkRoute: (
      entry: ConnectionCatalogEntry,
      route: ConnectionRoute,
    ) => Effect.Effect<RouteCheck>;
    readonly preflight: (
      entry: ConnectionCatalogEntry,
      route: ConnectionRoute,
    ) => Effect.Effect<boolean>;
  }
>()("@goat/client-runtime/connection/driver/ConnectionDriver") {}

export const connectOverRoutes = Effect.fn("ConnectionDriver.connectOverRoutes")(function* <R>(
  entry: ConnectionCatalogEntry,
  checkRoute: (route: ConnectionRoute) => Effect.Effect<RouteCheck>,
  connectRoute: (
    route: ConnectionRoute,
  ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, R | Scope.Scope>,
) {
  const routes = usableRoutes(entry);
  if (
    routes.length === 0 &&
    connectionRoutes(entry).some((route) => !isConnectionRouteEnabled(route))
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: `${GOAT_CONNECT_COMING_SOON.title} is coming soon. ${GOAT_CONNECT_COMING_SOON.description}`,
    });
  }
  const checks =
    routes.length === 1
      ? []
      : yield* Effect.forEach(routes, (route) => Effect.forkChild(checkRoute(route)));
  const attemptScope = yield* Scope.Scope;
  let transient: ConnectionTransientError | undefined;
  let blocked: ConnectionBlockedError | undefined;
  // Each route gets its own scope so a half-open session closes before the next try.
  const attempt = Effect.fnUntraced(function* (route: ConnectionRoute) {
    const routeScope = yield* Scope.fork(attemptScope);
    const result = yield* connectRoute(route).pipe(
      Scope.provide(routeScope),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(routeScope, exit))),
      Effect.result,
    );
    if (result._tag === "Failure") {
      if (result.failure._tag === "ConnectionAttemptSuperseded") return yield* result.failure;
      if (result.failure._tag === "ConnectionTransientError") transient ??= result.failure;
      else blocked ??= result.failure;
    }
    return result;
  });
  const silent: Array<ConnectionRoute> = [];
  for (const [index, route] of routes.entries()) {
    const check = checks.length === 0 ? "unchecked" : yield* Fiber.join(checks[index]!);
    if (check === "silent") {
      silent.push(route);
      continue;
    }
    const result = yield* attempt(route);
    if (result._tag === "Success") return result.success;
    // An incompatible server is the same server on every route.
    if (result.failure.reason === "unsupported") return yield* result.failure;
  }
  for (const route of silent) {
    const result = yield* attempt(route);
    if (result._tag === "Success") return result.success;
    if (result.failure.reason === "unsupported") return yield* result.failure;
  }
  return yield* (
    transient ??
      blocked ??
      new ConnectionTransientError({
        reason: "endpoint-unavailable",
        detail: `${entry.target.label} did not answer on any saved route.`,
      })
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const resolver = yield* ConnectionResolver.ConnectionResolver;
  const sessions = yield* RpcSession.RpcSessionFactory;
  const httpClient = yield* HttpClient.HttpClient;

  const checkRoute = (entry: ConnectionCatalogEntry, route: ConnectionRoute) => {
    if (!isConnectionRouteEnabled(route)) return Effect.succeed<RouteCheck>("silent");
    const httpBaseUrl = routeHttpBaseUrl(route);
    if (httpBaseUrl === null) return Effect.succeed<RouteCheck>("unchecked");
    // The descriptor is public, so this sends no credential to whatever
    // answers at a saved LAN address on a different network.
    return fetchRemoteEnvironmentDescriptor({
      httpBaseUrl,
      timeoutMs: ROUTE_CHECK_TIMEOUT_MS,
    }).pipe(
      Effect.map((descriptor): RouteCheck =>
        descriptor.environmentId === entry.target.environmentId ? "answered" : "silent",
      ),
      Effect.orElseSucceed((): RouteCheck => "silent"),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.withSpan("ConnectionDriver.checkRoute", {
        attributes: { "connection.target.kind": route.target._tag },
      }),
    );
  };

  const connect = Effect.fn("ConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
    attemptContext?: Omit<ConnectionAttemptIdentity, "routeId">,
  ) {
    const target = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
      "connection.route.count": connectionRoutes(entry).length,
    });
    return yield* connectOverRoutes(
      entry,
      (route) => checkRoute(entry, route),
      Effect.fnUntraced(
        function* (route) {
          const routeId = connectionRouteId(route.target);
          yield* reportProgress({ stage: "preparing", routeId });
          const prepared = yield* resolver.prepare(
            routeEntry(entry, route),
            reportProgress({ stage: "preparing", routeId, hostAnswered: true }),
            {
              ...(attemptContext === undefined
                ? {}
                : { attemptContext: { ...attemptContext, routeId } }),
              onPreparationProgress: (sshPreparation) =>
                reportProgress({ stage: "preparing", routeId, sshPreparation }),
            },
          );
          yield* reportProgress({ stage: "opening", routeId, prepared });
          const session = yield* Effect.gen(function* () {
            const session = yield* sessions.connect(prepared);
            yield* reportProgress({ stage: "synchronizing", routeId, prepared });
            yield* session.ready;
            return session;
          }).pipe((effect) =>
            route.target._tag === "SshConnectionTarget"
              ? withSshConnectionTiming("ready")(effect)
              : effect,
          );
          return { prepared, session } satisfies EnvironmentConnectionLease;
        },
        (effect, route) =>
          route.target._tag === "SshConnectionTarget"
            ? withSshConnectionTiming("attempt")(effect)
            : effect,
      ),
    );
  });

  const preflight = (entry: ConnectionCatalogEntry, route: ConnectionRoute) =>
    (sendsTokenInClear(connectionRoutes(entry), route)
      ? Effect.succeed("silent" as const)
      : checkRoute(entry, route)
    ).pipe(
      Effect.flatMap((check) =>
        check === "answered"
          ? resolver.prepare(routeEntry(entry, route)).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
          : Effect.succeed(false),
      ),
      Effect.withSpan("ConnectionDriver.preflight"),
    );

  return ConnectionDriver.of({ connect, checkRoute, preflight });
});

export const layer = Layer.effect(ConnectionDriver, make);
