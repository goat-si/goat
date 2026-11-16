import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Auth from "./EnvironmentAuth.ts";
import * as Access from "./HubConnectAccess.ts";
import * as Secrets from "./ServerSecretStore.ts";
import * as Sessions from "./SessionStore.ts";
import * as Lifetime from "./SessionSocketLifetime.ts";
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
  Layer.provide(Config.layerTest(process.cwd(), { prefix: "goat-connect-socket-" })),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
