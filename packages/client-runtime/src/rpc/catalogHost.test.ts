import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  WS_METHODS,
  type ConnectionCatalogHostResponse,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "./session.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import { serveConnectionCatalog } from "./catalogHost.ts";

const makeHarness = Effect.gen(function* () {
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("primary"),
      label: "Local",
      httpBaseUrl: "http://localhost/",
      wsBaseUrl: "ws://localhost/",
    }),
    state,
    prepared,
    session: activeSession,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  return { activeSession, supervisor };
});
function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

describe("connection catalog RPC host", () => {
  it.effect(
    "processes serially, replies on the receiving session, and attaches after reconnect",
    () =>
      Effect.gen(function* () {
        const { activeSession, supervisor } = yield* makeHarness;
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const firstSessionDone = yield* Deferred.make<void>();
        const secondSessionDone = yield* Deferred.make<void>();
        const started = yield* Ref.make(0);
        const responses: Array<{ socket: string; response: ConnectionCatalogHostResponse }> = [];
        function makeSession(socket: string, requestIds: string[], done: Deferred.Deferred<void>) {
          const client = {
            [WS_METHODS.connectionCatalogServe]: () =>
              Stream.make(
                ...requestIds.map((requestId) => ({
                  requestId,
                  expiresAt: "1970-01-01T00:10:00.000Z",
                  operation: { type: "list" as const },
                })),
              ).pipe(Stream.concat(Stream.never)),
            [WS_METHODS.connectionCatalogRespond]: (response: ConnectionCatalogHostResponse) =>
              Effect.gen(function* () {
                responses.push({ socket, response });
                if (response.requestId === requestIds.at(-1))
                  yield* Deferred.succeed(done, undefined);
              }),
          } as unknown as WsRpcProtocolClient;
          return session(client);
        }
        yield* SubscriptionRef.set(
          activeSession,
          Option.some(makeSession("first", ["one", "two"], firstSessionDone)),
        );
        const host = yield* serveConnectionCatalog(() =>
          Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(started, (count) => count + 1);
            if (count === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            return { type: "list" as const, connections: [] };
          }),
        ).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkScoped,
        );
        yield* Deferred.await(firstStarted);
        expect(yield* Ref.get(started)).toBe(1);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(firstSessionDone);
        yield* SubscriptionRef.set(activeSession, Option.none());
        yield* SubscriptionRef.set(
          activeSession,
          Option.some(makeSession("second", ["three"], secondSessionDone)),
        );
        yield* Deferred.await(secondSessionDone);
        expect(responses.map(({ socket, response }) => [socket, response.requestId])).toEqual([
          ["first", "one"],
          ["first", "two"],
          ["second", "three"],
        ]);
        expect(yield* Ref.get(started)).toBe(3);
        yield* Fiber.interrupt(host);
      }).pipe(Effect.scoped),
  );

  it.effect("quiets an authorization refusal until the next primary session", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const refused = yield* Deferred.make<void>();
      const handled = yield* Deferred.make<void>();
      let responses = 0;
      const rejectedClient = {
        [WS_METHODS.connectionCatalogServe]: () =>
          Stream.fromEffect(Deferred.succeed(refused, undefined)).pipe(
            Stream.flatMap(() =>
              Stream.fail(
                new EnvironmentAuthorizationError({
                  message: "Desktop only",
                  requiredScope: "settings:write",
                }),
              ),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(activeSession, Option.some(session(rejectedClient)));
      const host = yield* serveConnectionCatalog(() =>
        Effect.succeed({ type: "list", connections: [] }),
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkScoped,
      );
      yield* Deferred.await(refused);
      const acceptedClient = {
        [WS_METHODS.connectionCatalogServe]: () =>
          Stream.succeed({
            requestId: "accepted",
            expiresAt: "1970-01-01T00:10:00.000Z",
            operation: { type: "list" as const },
          }).pipe(Stream.concat(Stream.never)),
        [WS_METHODS.connectionCatalogRespond]: () =>
          Effect.gen(function* () {
            responses++;
            yield* Deferred.succeed(handled, undefined);
          }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(activeSession, Option.some(session(acceptedClient)));
      yield* Deferred.await(handled);
      expect(responses).toBe(1);
      yield* Fiber.interrupt(host);
    }).pipe(Effect.scoped),
  );

  it.effect("skips requests that expire waiting in the serial lane and runs the next one", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const handled: string[] = [];
      const responses: string[] = [];
      const client = {
        [WS_METHODS.connectionCatalogServe]: () =>
          Stream.make(
            {
              requestId: "first",
              expiresAt: "1970-01-01T00:10:00.000Z",
              operation: { type: "list" as const },
            },
            {
              requestId: "expired",
              expiresAt: "1970-01-01T00:00:30.000Z",
              operation: { type: "remove" as const, environmentId: EnvironmentId.make("expired") },
            },
            {
              requestId: "next",
              expiresAt: "1970-01-01T00:10:00.000Z",
              operation: { type: "remove" as const, environmentId: EnvironmentId.make("next") },
            },
          ).pipe(Stream.concat(Stream.never)),
        [WS_METHODS.connectionCatalogRespond]: (response: ConnectionCatalogHostResponse) =>
          Effect.gen(function* () {
            responses.push(response.requestId);
            if (response.requestId === "next") yield* Deferred.succeed(done, undefined);
          }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const host = yield* serveConnectionCatalog((operation) =>
        Effect.gen(function* () {
          handled.push(operation.type === "remove" ? operation.environmentId : "first");
          if (operation.type === "list") {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          }
          return { type: "list" as const, connections: [] };
        }),
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkScoped,
      );
      yield* Deferred.await(firstStarted);
      yield* TestClock.adjust(30_000);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(done);
      expect(handled).toEqual(["first", "next"]);
      expect(responses).toEqual(["first", "next"]);
      yield* Fiber.interrupt(host);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "finishes an in-progress operation and replies on its original session when interrupted",
    () =>
      Effect.gen(function* () {
        const { activeSession, supervisor } = yield* makeHarness;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const responses: ConnectionCatalogHostResponse[] = [];
        let completed = false;
        const client = {
          [WS_METHODS.connectionCatalogServe]: () =>
            Stream.succeed({
              requestId: "add",
              expiresAt: "1970-01-01T00:10:00.000Z",
              operation: { type: "list" as const },
            }).pipe(Stream.concat(Stream.never)),
          [WS_METHODS.connectionCatalogRespond]: (response: ConnectionCatalogHostResponse) =>
            Effect.sync(() => {
              responses.push(response);
            }),
        } as unknown as WsRpcProtocolClient;
        yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
        const host = yield* serveConnectionCatalog(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            completed = true;
            return { type: "list" as const, connections: [] };
          }),
        ).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkScoped,
        );
        yield* Deferred.await(started);
        yield* SubscriptionRef.set(activeSession, Option.none());
        const interrupted = yield* Fiber.interrupt(host).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupted);
        expect(completed).toBe(true);
        expect(responses).toEqual([
          { requestId: "add", result: { type: "list", connections: [] } },
        ]);
      }).pipe(Effect.scoped),
  );
});
