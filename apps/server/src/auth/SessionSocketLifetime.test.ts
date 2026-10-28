import * as Stream from "effect/Stream";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Auth from "./EnvironmentAuth.ts";
import * as Access from "./HubConnectAccess.ts";
import * as Secrets from "./ServerSecretStore.ts";
import * as Sessions from "./SessionStore.ts";
import * as Lifetime from "./SessionSocketLifetime.ts";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { serve } from "../hubProxy/testFixtures.ts";

const layer = Auth.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(Secrets.layer),
  Layer.provide(Environment.layerIdentity),
  Layer.provide(Config.layerTest(process.cwd(), { prefix: "goat-connect-socket-" })),
  Layer.provide(NodeServices.layer),
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
            `${origin.replace(/^http/u, "ws")}ws?wsTicket=${encodeURIComponent(ticket.ticket)}`,
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
