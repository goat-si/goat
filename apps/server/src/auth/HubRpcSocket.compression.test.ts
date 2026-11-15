import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { guardErrors } from "@goat/shared/errorGuards";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import { createGuardedHttpServer } from "../httpResponseErrorGuard.ts";
import * as ServerConfig from "../config.ts";
import * as Auth from "./EnvironmentAuth.ts";
import * as Access from "./HubConnectAccess.ts";
import * as Sessions from "./SessionStore.ts";
import * as HubRpcSocket from "./HubRpcSocket.ts";

it.live.each([
  { subject: "desktop-bootstrap", proxy: false, extension: "" },
  { subject: "desktop-bootstrap", proxy: true, extension: "permessage-deflate" },
  { subject: "one-time-token", proxy: false, extension: "permessage-deflate" },
  { subject: "cloud-connect", proxy: true, extension: "permessage-deflate" },
  {
    subject: "desktop-bootstrap",
    proxy: false,
    reportedPeer: "172.20.0.1",
    wsl: true,
    extension: "",
  },
  {
    subject: "desktop-bootstrap",
    proxy: true,
    reportedPeer: "172.20.0.1",
    wsl: true,
    extension: "permessage-deflate",
  },
  {
    subject: "desktop-bootstrap",
    proxy: false,
    reportedPeer: "172.20.0.1",
    wsl: false,
    extension: "permessage-deflate",
  },
  {
    subject: "desktop-bootstrap",
    proxy: false,
    reportedPeer: "203.0.113.4",
    wsl: true,
    extension: "permessage-deflate",
  },
])(
  "negotiates WebSocket compression for $subject (proxy=$proxy)",
  ({ subject, proxy, extension, reportedPeer, wsl }) =>
    Effect.gen(function* () {
      const routes = HubRpcSocket.layer(() =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const socket = yield* request.upgrade;
          const reader = yield* socket.reader;
          yield* Stream.fromPull(Effect.succeed(reader.pull)).pipe(Stream.runDrain, Effect.ignore);
          return HttpServerResponse.empty();
        }),
      );
      const accessState = yield* SubscriptionRef.make({
        generation: 0,
        allowed: false,
        fenced: false,
      });
      const desktopConfig = Layer.effect(
        ServerConfig.ServerConfig,
        Effect.map(ServerConfig.ServerConfig, (config) => ({
          ...config,
          mode: "desktop" as const,
        })),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-ws-compression-" })),
        Layer.provide(NodeServices.layer),
      );
      const services = yield* Layer.build(
        HttpRouter.serve(routes, { disableListenLog: true }).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(
              () => {
                const server = createGuardedHttpServer();
                if (reportedPeer)
                  server.prependListener("connection", (socket) => {
                    Object.defineProperties(socket, {
                      localAddress: { value: "172.20.0.2" },
                      remoteAddress: { value: reportedPeer },
                    });
                  });
                return server;
              },
              {
                host: "127.0.0.1",
                port: 0,
                websocket: { perMessageDeflate: true },
              },
            ),
          ),
          Layer.provide(
            Layer.mergeAll(
              desktopConfig,
              Layer.mock(Auth.EnvironmentAuth)({
                authenticateWebSocketUpgrade: () =>
                  Effect.succeed({
                    sessionId: AuthSessionId.make("compression-test"),
                    subject,
                    principalKind: "person",
                    method: "bearer-access-token",
                    scopes: [],
                  }),
              }),
              Layer.mock(Access.HubConnectAccess)({
                state: accessState,
                current: SubscriptionRef.get(accessState),
                awaitDenial: () => Effect.never,
              }),
              Layer.mock(Sessions.SessionStore)({
                cookieName: "compression-test",
                legacyCookieName: undefined,
                markConnected: () => Effect.void,
                markDisconnected: () => Effect.void,
                awaitInvalidation: () => Effect.never,
              }),
            ),
          ),
          Layer.provide(Layer.succeed(HostProcess.Platform, wsl ? "linux" : "darwin")),
          Layer.provide(
            Layer.succeed(HostProcess.Environment, wsl ? { WSL_DISTRO_NAME: "fixture" } : {}),
          ),
        ),
      );
      const { address } = Context.get(services, HttpServer.HttpServer);
      const url = new URL("/ws", HttpServer.formatAddress(address).replace(/^http/u, "ws"));
      url.searchParams.set(
        ORCHESTRATION_PROTOCOL_QUERY_PARAM,
        String(ORCHESTRATION_PROTOCOL_VERSION),
      );
      const opened = Promise.withResolvers<void>();
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const socket = guardErrors(
            new NodeWS.WebSocket(url, {
              origin: "goat://app",
              ...(proxy ? { headers: { "x-forwarded-for": "192.0.2.1" } } : {}),
            }),
            opened.reject,
          );
          socket.once("open", () => opened.resolve());
          return socket;
        }),
        (socket) => Effect.sync(() => socket.terminate()),
      );
      yield* Effect.promise(() => opened.promise);
      assert.equal(client.extensions, extension);
    }).pipe(Effect.scoped),
);
