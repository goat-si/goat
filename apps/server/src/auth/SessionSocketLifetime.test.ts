import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  BotId,
  CHANNEL_GATEWAY_WS_METHODS,
  ChannelTaskId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  WsChannelRpcGroup,
  type AuthEnvironmentScope,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import * as Auth from "./EnvironmentAuth.ts";
import * as Access from "./HubConnectAccess.ts";
import * as Secrets from "./ServerSecretStore.ts";
import * as Sessions from "./SessionStore.ts";
import * as Lifetime from "./SessionSocketLifetime.ts";
import * as HubRpcSocket from "./HubRpcSocket.ts";
import * as SettingsSessionPermit from "./settingsSessionPermit.ts";
import { MAIN_LISTENER } from "./connectionContext.testkit.ts";
import { layerHubAccess, makeCheckProbe, makeServerAndCli } from "./DurableRevocations.testkit.ts";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { serve } from "../hubProxy/testFixtures.ts";

const layer = Auth.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(Secrets.layer),
  Layer.provide(Environment.layerIdentity),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "goat-connect-socket-" })),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.effect(
  "denies snooze writes without operate scope and closes the RPC connection on revocation",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.SessionStore;
      const { snoozeBotTask, unsnoozeBotTask } = CHANNEL_GATEWAY_WS_METHODS;
      const tags = [...WsChannelRpcGroup.requests.values()].map((rpc) => rpc._tag);
      const group = WsChannelRpcGroup.omit(
        ...tags.filter((tag) => tag !== snoozeBotTask && tag !== unsnoozeBotTask),
      );
      const target = { taskId: ChannelTaskId.make("release-check"), botId: BotId.make("main") };
      const until = "2026-11-12T10:00:00.000Z";
      const view = { taskId: target.taskId, pinnedAt: null, doneAt: null, readThrough: null };
      let active = false;
      const closed = yield* Deferred.make<void>();
      const routes = HubRpcSocket.layer((session) =>
        Effect.gen(function* () {
          const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
          yield* RpcServer.make(group).pipe(
            Effect.provideService(RpcServer.Protocol, protocol),
            Effect.provide(
              Layer.mergeAll(
                group.toLayer({
                  [snoozeBotTask]: () =>
                    Effect.sync(() => {
                      active = true;
                      return { ...view, snoozedUntil: until };
                    }),
                  [unsnoozeBotTask]: () =>
                    Effect.sync(() => {
                      active = false;
                      return view;
                    }),
                }),
                HubRpcSocket.rpcAuthorization(session, sessions),
              ),
            ),
            Effect.forkScoped,
          );
          return yield* httpEffect.pipe(
            Effect.ensuring(
              session.scopes.includes(AuthOrchestrationOperateScope)
                ? Deferred.succeed(closed, undefined)
                : Effect.void,
            ),
          );
        }).pipe(Effect.provide(RpcSerialization.layerJson)),
      );
      const origin = yield* serve(routes);
      const connect = Effect.fn("SnoozeAuthorizationTest.connect")(function* (
        scopes: ReadonlyArray<AuthEnvironmentScope>,
      ) {
        const issued = yield* sessions.issue({ scopes });
        const { token } = yield* sessions.issueWebSocketToken(issued.sessionId, {
          audience: "rpc",
        });
        const url = new URL("/ws", origin.replace(/^http/u, "ws"));
        url.searchParams.set(
          ORCHESTRATION_PROTOCOL_QUERY_PARAM,
          ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        );
        url.searchParams.set("wsTicket", token);
        const socket = yield* Socket.makeWebSocket(url.toString()).pipe(
          Effect.provide(NodeWS.layerWebSocketConstructor),
        );
        const protocol = yield* RpcClient.makeProtocolSocket({ retryTransientErrors: false }).pipe(
          Effect.provideService(Socket.Socket, socket),
          Effect.provide(RpcSerialization.layerJson),
        );
        const client = yield* RpcClient.make(group).pipe(
          Effect.provideService(RpcClient.Protocol, protocol),
        );
        return { client, sessionId: issued.sessionId };
      });
      const reader = yield* connect([AuthOrchestrationReadScope]);
      const denied = yield* reader.client[snoozeBotTask]({ ...target, until }).pipe(Effect.flip);
      expect(denied).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
      expect(active).toBe(false);

      const operator = yield* connect([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
      expect(yield* operator.client[snoozeBotTask]({ ...target, until })).toEqual({
        ...view,
        snoozedUntil: until,
      });
      expect(yield* reader.client[unsnoozeBotTask](target).pipe(Effect.flip)).toMatchObject({
        requiredScope: AuthOrchestrationOperateScope,
      });
      expect(yield* sessions.revoke(operator.sessionId)).toBe(true);
      yield* Deferred.await(closed);
      expect(yield* operator.client[unsnoozeBotTask](target).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });
      expect(active).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("closing the Pen membership view closes a socket without revoking its session", () =>
  Effect.gen(function* () {
    const sessions = yield* Sessions.SessionStore;
    const auth = yield* Auth.EnvironmentAuth;
    const node = "a".repeat(26);
    yield* sessions.followPenMembers(Effect.succeed(new Set([node])));
    const issued = yield* sessions.issue({ penMemberNode: node });
    const verified = yield* sessions.verify(issued.token, MAIN_LISTENER);
    const ticket = yield* auth.issueWebSocketTicket(verified, { use: "rpc" });
    const admitted = yield* Deferred.make<void>();
    const routes = HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth.authenticateWebSocketUpgrade(request, "rpc");
        return yield* Lifetime.run(
          session,
          Effect.gen(function* () {
            const socket = yield* request.upgrade;
            const reader = yield* socket.reader;
            yield* Deferred.succeed(admitted, undefined);
            yield* Stream.fromPull(Effect.succeed(reader.pull)).pipe(Stream.runDrain);
            return HttpServerResponse.empty();
          }),
        );
      }),
    );
    const origin = yield* serve(routes);
    const closed = Promise.withResolvers<void>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const client = new NodeWS.WebSocket(
          `${origin.replace(/^http/u, "ws")}ws?wsTicket=${encodeURIComponent(Redacted.value(ticket.ticket))}`,
        );
        client.on("close", () => closed.resolve());
        client.on("error", () => {});
        return client;
      }),
      (client) => Effect.sync(() => client.terminate()),
    );
    yield* Deferred.await(admitted);
    yield* sessions.followPenMembers(Effect.succeed("closed"));
    yield* Effect.promise(() => closed.promise);
    expect(yield* sessions.listPenMemberSessions).toEqual([
      { sessionId: issued.sessionId, penMemberNode: node },
    ]);
    yield* sessions.followPenMembers(Effect.succeed(new Set([node])));
    expect((yield* sessions.readActiveScopes(issued.sessionId)).length).toBeGreaterThan(0);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each([false, true])(
  "the hub socket lifetime helper closes on failed withdrawal (server-to-client traffic: %s)",
  (sendData) =>
    Effect.gen(function* () {
      const auth = yield* Auth.EnvironmentAuth;
      const sessions = yield* Sessions.SessionStore;
      const access = yield* Access.HubConnectAccess;
      const sql = yield* SqlClient.SqlClient;
      yield* access.commitPolicy(true, Effect.void);
      const token = yield* sessions.issue({
        subject: "cloud-connect",
        scopes: ["hub:proxy"],
        connectAccessGeneration: (yield* access.current).generation,
      });
      const ticket = yield* auth.issueWebSocketTicket(token, { use: "rpc" });
      const admitted = yield* Deferred.make<void>();
      const routes = HttpRouter.add(
        "GET",
        "/ws",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const session = yield* auth.authenticateWebSocketUpgrade(request, "rpc");
          return yield* Lifetime.run(
            session,
            Effect.gen(function* () {
              const socket = yield* request.upgrade;
              const reader = yield* socket.reader;
              if (sendData) yield* (yield* socket.writer).write("server-to-client");
              yield* Deferred.succeed(admitted, undefined);
              yield* Stream.fromPull(Effect.succeed(reader.pull)).pipe(Stream.runDrain);
              return HttpServerResponse.empty();
            }),
          );
        }),
      );
      const origin = yield* serve(routes);
      const opened = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const message = Promise.withResolvers<string>();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const client = new NodeWS.WebSocket(
            `${origin.replace(/^http/u, "ws")}ws?wsTicket=${encodeURIComponent(Redacted.value(ticket.ticket))}`,
          );
          client.on("open", () => opened.resolve());
          client.on("close", () => closed.resolve());
          client.on("message", (data) => message.resolve(data.toString()));
          client.on("error", () => {});
          return client;
        }),
        (client) => Effect.sync(() => client.terminate()),
      );
      yield* Effect.promise(() => opened.promise);
      yield* Deferred.await(admitted);
      if (sendData) expect(yield* Effect.promise(() => message.promise)).toBe("server-to-client");
      yield* sql`CREATE TRIGGER fail_connect_bump BEFORE UPDATE ON hub_connect_access BEGIN SELECT RAISE(FAIL, 'injected write failure'); END`;
      expect(yield* access.commitPolicy(false, Effect.void).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });
      yield* Effect.promise(() => closed.promise);
      expect(yield* access.current).toMatchObject({ allowed: false, fenced: true });
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "a session the command line revokes closes its open socket at the next check, then refuses settings writes and credentials",
  () =>
    Effect.gen(function* () {
      const probe = yield* makeCheckProbe;
      const { running, fromCli } = yield* makeServerAndCli(probe.wrap);
      yield* Effect.gen(function* () {
        const sessions = yield* Sessions.SessionStore;
        const token = yield* sessions.issue({ subject: "phone" });
        // Keeps a session live so the next check reads and proves this one ended.
        yield* sessions.issue({ subject: "kept" });
        const ticket = yield* sessions.issueWebSocketToken(token.sessionId, { audience: "rpc" });
        const admitted = yield* Deferred.make<Sessions.VerifiedWebSocketTicket>();
        const updates = yield* Queue.unbounded<string>();
        const routes = HttpRouter.add(
          "GET",
          "/ws",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const wsTicket = new URL(request.url, "http://localhost").searchParams.get("wsTicket");
            const session = yield* sessions.verifyWebSocketToken(wsTicket ?? "", MAIN_LISTENER);
            return yield* Lifetime.run(
              session,
              Effect.gen(function* () {
                const socket = yield* request.upgrade;
                const reader = yield* socket.reader;
                const writer = yield* socket.writer;
                yield* writer.write("tick");
                yield* Deferred.succeed(admitted, session);
                // A subscription keeps streaming to the client while the revocation lands.
                yield* Effect.all(
                  [
                    Stream.fromPull(Effect.succeed(reader.pull)).pipe(Stream.runDrain),
                    Stream.fromQueue(updates).pipe(
                      Stream.runForEach((update) => writer.write(update)),
                    ),
                  ],
                  { concurrency: "unbounded", discard: true },
                );
                return HttpServerResponse.empty();
              }),
            );
          }).pipe(Effect.orDie),
        );
        const origin = yield* serve(routes);
        const opened = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        const firstMessage = Promise.withResolvers<string>();
        let isClosed = false;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const client = new NodeWS.WebSocket(
              `${origin.replace(/^http/u, "ws")}ws?wsTicket=${encodeURIComponent(ticket.token)}`,
            );
            client.on("open", () => opened.resolve());
            client.on("close", () => {
              isClosed = true;
              closed.resolve();
            });
            client.on("message", (data) => firstMessage.resolve(data.toString()));
            client.on("error", () => {});
            return client;
          }),
          (client) => Effect.sync(() => client.terminate()),
        );
        yield* Effect.promise(() => opened.promise);
        const session = yield* Deferred.await(admitted);
        expect(yield* Effect.promise(() => firstMessage.promise)).toBe("tick");
        const authorizeSettings = yield* SettingsSessionPermit.make(session);
        const patch = { hub: { enabled: true } };
        yield* authorizeSettings(patch);

        // A second store on the same database is what `goat auth session revoke` runs.
        yield* Queue.offer(updates, "update before revoke");
        yield* fromCli((cli) => cli.revoke(token.sessionId));
        yield* Queue.offer(updates, "update after revoke");
        yield* probe.pass(
          Effect.gen(function* () {
            expect(
              yield* sessions
                .readActiveScopes(token.sessionId)
                .pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "live" })),
            ).toBe("UnknownSessionTokenError");
          }),
        );
        // The socket's lifetime subscribed at admission, before the removal was published.
        yield* Effect.promise(() => closed.promise);
        expect(isClosed).toBe(true);

        // This checks the permit a settings write passes before commit, not a routed RPC.
        expect(
          yield* authorizeSettings(patch).pipe(
            Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "authorized" }),
          ),
        ).toBe("ServerSettingsError");
        // The ticket route verifies the session first, and a ticket minted earlier fails at upgrade.
        expect((yield* sessions.verify(token.token, MAIN_LISTENER).pipe(Effect.flip))._tag).toBe(
          "SessionTokenRevokedError",
        );
        const late = yield* sessions.issueWebSocketToken(token.sessionId, { audience: "rpc" });
        expect(
          (yield* sessions.verifyWebSocketToken(late.token, MAIN_LISTENER).pipe(Effect.flip))._tag,
        ).toBe("WebSocketSessionRevokedError");
      }).pipe(Effect.provide(Layer.merge(running, layerHubAccess)), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "a kept desktop session's open socket keeps delivering through Revoke others and closes once its row is revoked by itself",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.SessionStore;
      const desktop = yield* sessions.issue({
        subject: "desktop-bootstrap",
        method: "bearer-access-token",
      });
      const settingsPage = yield* sessions.issue({ subject: "settings-page" });
      const ticket = yield* sessions.issueWebSocketToken(desktop.sessionId, { audience: "rpc" });
      const admitted = yield* Deferred.make<void>();
      const updates = yield* Queue.unbounded<string>();
      const routes = HttpRouter.add(
        "GET",
        "/ws",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const wsTicket = new URL(request.url, "http://localhost").searchParams.get("wsTicket");
          const session = yield* sessions.verifyWebSocketToken(wsTicket ?? "", MAIN_LISTENER);
          return yield* Lifetime.run(
            session,
            Effect.gen(function* () {
              const socket = yield* request.upgrade;
              const reader = yield* socket.reader;
              const writer = yield* socket.writer;
              yield* Deferred.succeed(admitted, undefined);
              yield* Effect.all(
                [
                  Stream.fromPull(Effect.succeed(reader.pull)).pipe(Stream.runDrain),
                  Stream.fromQueue(updates).pipe(
                    Stream.runForEach((update) => writer.write(update)),
                  ),
                ],
                { concurrency: "unbounded", discard: true },
              );
              return HttpServerResponse.empty();
            }),
          );
        }).pipe(Effect.orDie),
      );
      const origin = yield* serve(routes);
      const opened = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<"closed">();
      const message = Promise.withResolvers<string>();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const client = new NodeWS.WebSocket(
            `${origin.replace(/^http/u, "ws")}ws?wsTicket=${encodeURIComponent(ticket.token)}`,
          );
          client.on("open", () => opened.resolve());
          client.on("close", () => closed.resolve("closed"));
          client.on("message", (data) => message.resolve(data.toString()));
          client.on("error", () => {});
          return client;
        }),
        (client) => Effect.sync(() => client.terminate()),
      );
      yield* Effect.promise(() => opened.promise);
      yield* Deferred.await(admitted);

      yield* sessions.revokeAllExcept(settingsPage.sessionId);
      expect(yield* sessions.readActiveScopes(desktop.sessionId)).toEqual(desktop.scopes);
      yield* Queue.offer(updates, "after Revoke others");

      expect(yield* Effect.promise(() => Promise.race([message.promise, closed.promise]))).toBe(
        "after Revoke others",
      );
      yield* sessions.revoke(desktop.sessionId);
      expect(yield* Effect.promise(() => closed.promise)).toBe("closed");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
