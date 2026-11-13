// @effect-diagnostics nodeBuiltinImport:off -- requests arrive on real loopback sockets.
import type * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, EnvironmentHttpApi, HUB_PROXY_NODE_SCOPE_CEILING } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { penConnection } from "../auth/connectionContext.testkit.ts";
import * as AuthHttp from "../auth/http.ts";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { issueAttachmentUploadUrl } from "../assets/AttachmentUpload.ts";
import * as AttachmentFileLeases from "../assets/AttachmentFileLeases.ts";
import * as PendingAttachmentSweep from "../assets/PendingAttachmentSweep.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { layerAttachmentUploadRoute } from "../http.ts";
import { createGuardedHttpServer } from "../httpResponseErrorGuard.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as PenEnablement from "./PenEnablement.ts";
import { layerTest as layerEnablement } from "./PenEnablement.testkit.ts";
import { dial, http, member, peerOf, PIN, prove, response } from "./penDaemon.testkit.ts";
import { layerPenRouteGate, layerPenSessionRoute } from "./PenHttp.ts";
import * as PenListener from "./PenListener.ts";
import * as PenSessions from "./PenSessions.ts";

const layerServices = (enabled: Layer.Layer<PenEnablement.PenEnablement>) =>
  PenSessions.layer.pipe(
    Layer.provideMerge(enabled),
    Layer.provideMerge(EnvironmentAuth.layer),
    Layer.provideMerge(SessionStore.layer),
    Layer.provideMerge(PendingAttachmentSweep.layer),
    Layer.provideMerge(AttachmentFileLeases.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("pen-http-test")),
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-pen-http-" })),
    Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  );

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const harness = Effect.gen(function* () {
  const seen: Array<string> = [];
  const record = (name: string) =>
    Effect.sync(() => {
      seen.push(name);
      return HttpServerResponse.text(name);
    });
  let main: NodeHttp.Server | undefined;
  yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(
        layerPenRouteGate,
        layerPenSessionRoute,
        layerAttachmentUploadRoute,
        HttpRouter.add("GET", "/api/projects", record("projects")),
        HttpRouter.add("GET", "/ws", record("ws")),
        HttpRouter.add("POST", "/mcp", record("mcp")),
        HttpApiBuilder.layer(AuthTestApi).pipe(
          Layer.provide(AuthHttp.layer),
          Layer.provide(AuthHttp.layerAuthenticatedAuth),
        ),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(
          () => {
            const server = createGuardedHttpServer();
            main = server;
            return server;
          },
          { port: 0, host: "127.0.0.1" },
        ),
      ),
    ),
  );
  const address = main?.address();
  const mainPort = typeof address === "object" && address !== null ? address.port : 0;
  const pen = yield* PenSessions.PenSessions;
  yield* pen.setGeneration(1);
  const listener = yield* PenListener.make({
    pin: PIN,
    generation: 1,
    mainServer: main!,
    admitAccept: Effect.succeed(true),
    onUnsafe: Effect.void,
  });
  return { port: listener.port, mainPort, seen, main: () => main! };
});

const call = (
  port: number,
  nodeId: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = "",
) =>
  prove(port, nodeId, { after: http(method, path, headers, body) }).pipe(Effect.flatMap(response));
const issue = (port: number, nodeId: string, body: object) =>
  call(
    port,
    nodeId,
    "POST",
    "/api/pen/session",
    { "content-type": "application/json" },
    JSON.stringify(body),
  ).pipe(Effect.map((answer) => (JSON.parse(answer.body) as { readonly token: string }).token));
const bearer = (token: string) => ({ authorization: "Bearer " + token });

it.layer(NodeServices.layer)("the Pen listener's HTTP surface (mesh link design §5)", (it) => {
  it.effect("each member session kind reaches its own routes and no other", () =>
    Effect.gen(function* () {
      const { port, seen } = yield* harness;
      const proxy = yield* issue(port, member("a"), {
        kind: "proxy",
        scopes: ["orchestration:read"],
      });
      const agent = yield* issue(port, member("a"), {
        kind: "agent",
        access: "approval-required",
        memory: "none",
        providersManage: false,
        settingsWrite: false,
      });
      expect((yield* call(port, member("a"), "GET", "/api/projects", bearer(proxy))).status).toBe(
        200,
      );
      expect((yield* call(port, member("a"), "GET", "/api/projects", bearer(agent))).status).toBe(
        404,
      );
      expect((yield* call(port, member("a"), "GET", "/api/projects")).status).toBe(401);
      expect((yield* call(port, member("b"), "GET", "/api/projects", bearer(proxy))).status).toBe(
        401,
      );
      expect(
        (yield* call(port, member("a"), "GET", "/api/auth/session", bearer(agent))).status,
      ).toBe(404);
      expect((yield* call(port, member("a"), "POST", "/mcp", bearer(agent))).status).toBe(200);
      expect((yield* call(port, member("a"), "POST", "/mcp", bearer(proxy))).status).toBe(404);
      expect(
        (yield* call(port, member("a"), "POST", "/api/pen/session", bearer(agent))).status,
      ).toBe(404);
      expect(
        (yield* call(port, member("a"), "GET", "/api/auth/session", bearer(proxy))).status,
      ).toBe(200);
      const upgrade = (token: string) => ({
        ...bearer(token),
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      });
      expect((yield* call(port, member("a"), "GET", "/ws", upgrade(agent))).status).toBe(404);
      expect((yield* call(port, member("a"), "GET", "/ws", upgrade(proxy))).status).toBe(200);
      expect(seen).toEqual(["projects", "mcp", "ws"]);
    }).pipe(Effect.scoped, Effect.provide(layerServices(layerEnablement(true)))),
  );

  it.effect(
    "the real session handler reports proxy restrictions and rejects invalid member sessions",
    () =>
      Effect.gen(function* () {
        const { port } = yield* harness;
        const body = { kind: "proxy", scopes: [...HUB_PROXY_NODE_SCOPE_CEILING] };
        const valid = yield* issue(port, member("a"), body);
        const revoked = yield* issue(port, member("a"), body);
        const answer = yield* call(port, member("a"), "GET", "/api/auth/session", bearer(valid));
        expect(answer.status).toBe(200);
        const state = JSON.parse(answer.body);
        expect(state).toMatchObject({ authenticated: true, proxiedByHub: true });
        expect(state.permissions).toEqual(
          expect.arrayContaining([...HUB_PROXY_NODE_SCOPE_CEILING]),
        );
        expect(state.permissions).not.toContain("hub:proxy");
        expect(
          (yield* call(port, member("b"), "GET", "/api/auth/session", bearer(valid))).status,
        ).toBe(401);
        const sessions = yield* SessionStore.SessionStore;
        const verified = yield* sessions.verify(valid, penConnection(peerOf(member("a"))).context);
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        expect((yield* Effect.flip(auth.issueWebSocketTicket(verified)))._tag).toBe(
          "ServerAuthWebSocketTokenIssueError",
        );
        const pen = yield* PenSessions.PenSessions;
        yield* pen.revokeExcept([]);
        expect(
          (yield* call(port, member("a"), "GET", "/api/auth/session", bearer(revoked))).status,
        ).toBe(401);
        const fresh = yield* issue(port, member("a"), body);
        expect(
          (yield* call(port, member("a"), "GET", "/api/auth/session", bearer(fresh))).status,
        ).toBe(200);
        yield* TestClock.adjust("12 hours");
        expect(
          (yield* call(port, member("a"), "GET", "/api/auth/session", bearer(fresh))).status,
        ).toBe(401);
      }).pipe(Effect.scoped, Effect.provide(layerServices(layerEnablement(true)))),
  );

  it.effect("a dispatch upload needs the member agent's bearer and a valid capability", () =>
    Effect.gen(function* () {
      const { port } = yield* harness;
      const agent = yield* issue(port, member("a"), {
        kind: "agent",
        access: "auto",
        memory: "none",
        providersManage: false,
        settingsWrite: false,
      });
      const proxy = yield* issue(port, member("a"), {
        kind: "proxy",
        scopes: ["orchestration:read"],
      });
      const upload = () =>
        issueAttachmentUploadUrl({
          type: "file",
          name: "a.txt",
          mimeType: "text/plain",
          sizeBytes: 6,
        });
      const text = "abcdef";
      expect(
        (yield* call(port, member("a"), "POST", (yield* upload()).relativeUrl, bearer(agent), text))
          .status,
      ).toBe(204);
      expect(
        (yield* call(port, member("a"), "POST", (yield* upload()).relativeUrl, {}, text)).status,
      ).toBe(401);
      expect(
        (yield* call(port, member("a"), "POST", (yield* upload()).relativeUrl, bearer(proxy), text))
          .status,
      ).toBe(404);
      expect(
        (yield* call(
          port,
          member("a"),
          "POST",
          "/api/attachments/upload/bad.token",
          bearer(agent),
          text,
        )).status,
      ).toBe(404);
    }).pipe(Effect.scoped, Effect.provide(layerServices(layerEnablement(true)))),
  );

  it.effect("refuses an oversized session request before reading it", () =>
    Effect.gen(function* () {
      const { port } = yield* harness;
      const big = JSON.stringify({
        kind: "proxy",
        scopes: ["orchestration:read"],
        pad: "x".repeat(5000),
      });
      expect((yield* call(port, member("a"), "POST", "/api/pen/session", {}, big)).status).toBe(
        413,
      );
      const answer = yield* call(port, member("a"), "POST", "/api/pen/session", {}, "{}");
      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.body)).toMatchObject({ code: "refused" });
    }).pipe(Effect.scoped, Effect.provide(layerServices(layerEnablement(true)))),
  );

  it.effect(
    "main-listener requests pass the gate unchanged; an injected socket with no context gets 404",
    () =>
      Effect.gen(function* () {
        const { mainPort, seen, main } = yield* harness;
        const direct = yield* dial(mainPort);
        direct.socket.write(http("GET", "/api/projects"));
        expect((yield* response(direct)).status).toBe(200);
        const stray = NodeNet.createServer((socket) => main().emit("connection", socket));
        yield* Effect.acquireRelease(
          Effect.callback<void>((resume) => {
            stray.listen(0, "127.0.0.1", () => resume(Effect.void));
          }),
          () => Effect.sync(() => stray.close()),
        );
        const address = stray.address();
        const injected = yield* dial(
          typeof address === "object" && address !== null ? address.port : 0,
        );
        injected.socket.write(http("GET", "/api/projects"));
        expect((yield* response(injected)).status).toBe(404);
        expect(seen).toEqual(["projects"]);
      }).pipe(Effect.scoped, Effect.provide(layerServices(layerEnablement(true)))),
  );
});

it.layer(NodeServices.layer)("with the build's gate closed", (it) => {
  it.effect("a Pen connection reaches nothing, upgrades included, and no session is issued", () =>
    Effect.gen(function* () {
      const { port, seen } = yield* harness;
      expect(PenEnablement.PEN_TARGET_ENABLED).toBe(false);
      expect((yield* call(port, member("a"), "POST", "/api/pen/session", {}, "{}")).status).toBe(
        404,
      );
      expect((yield* call(port, member("a"), "GET", "/api/projects", bearer("x"))).status).toBe(
        404,
      );
      expect(
        (yield* call(port, member("a"), "GET", "/ws", {
          authorization: "Bearer x",
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
        })).status,
      ).toBe(404);
      expect(seen).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layerServices(PenEnablement.layer))),
  );
});
