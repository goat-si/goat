// @effect-diagnostics-next-line nodeBuiltinImport:off -- sends an oversized declared body without allocating it.
import * as NodeHttp from "node:http";

import { expect, it } from "@effect/vitest";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import {
  AuthStandardClientScopes,
  EnvironmentAuthorizationError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import {
  authLayer,
  makeRpcClient,
  NODE_SENTINEL,
  NODE_TOKEN,
  phoneScopes,
  readScopes,
  startHub,
} from "./testFixtures.ts";

const fetchResponse = (url: string, token?: string, method: "GET" | "POST" = "GET") =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client[method === "GET" ? "get" : "post"](url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, headers: response.headers, text: yield* response.text };
  }).pipe(Effect.provide(FetchHttpClient.layer));

const rawSocket = Effect.fnUntraced(function* (url: string) {
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<number>();
  const failureBody = Promise.withResolvers<string>();
  const frames = yield* Queue.unbounded<string>();
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const client = new NodeWS.WebSocket(url);
      client.on("open", () => opened.resolve());
      client.on("close", () => closed.resolve());
      client.on("error", () => {});
      client.on("unexpected-response", (_request, response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk.toString();
        });
        response.on("end", () => failureBody.resolve(body));
        response.resume();
        failed.resolve(response.statusCode ?? 0);
      });
      client.on("message", (data) => Queue.offerUnsafe(frames, data.toString()));
      return client;
    }),
    (client) => Effect.sync(() => client.terminate()),
  );
  return {
    socket,
    frames,
    opened: Effect.promise(() => opened.promise),
    closed: Effect.promise(() => closed.promise),
    failed: Effect.promise(() => failed.promise),
    failureBody: Effect.promise(() => failureBody.promise),
  };
});

const ticketUrl = Effect.fnUntraced(function* (
  hub: Effect.Success<ReturnType<typeof startHub>>,
  session: Awaited<Effect.Success<ReturnType<typeof hub.auth.issueSession>>>,
) {
  const ticket = yield* hub.auth.issueWebSocketTicket(session);
  return `${hub.baseUrl.replace(/^http/u, "ws")}hub/nodes/node-1/ws?wsTicket=${encodeURIComponent(ticket.ticket)}&orchestrationProtocol=1001`;
});

it.effect(
  "T1/T2/T8: refuses unauthenticated, unscoped, unknown and malformed node requests without dialing",
  () =>
    Effect.gen(function* () {
      const hub = yield* startHub();
      const noProxy = yield* hub.auth.issueSession({ scopes: ["orchestration:read"] });
      const allowed = yield* hub.auth.issueSession({ scopes: phoneScopes });
      expect(
        (yield* fetchResponse(`${hub.baseUrl}hub/nodes/node-1/api/orchestration/shell`)).status,
      ).toBe(401);
      expect(
        (yield* fetchResponse(
          `${hub.baseUrl}hub/nodes/node-1/api/orchestration/shell`,
          noProxy.token,
        )).status,
      ).toBe(403);
      for (const id of ["unknown", "%E0%A4%A", "%2Fother%2Fhost"]) {
        expect(
          (yield* fetchResponse(
            `${hub.baseUrl}hub/nodes/${id}/api/orchestration/shell`,
            allowed.token,
          )).status,
        ).toBe(404);
      }
      expect(hub.ssh.endpoints).toEqual([]);
      expect(hub.ssh.issues).toEqual([]);
      expect(hub.node.requests).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect(
  "T3/F2/T5: real RPC streams reads, rejects writes locally, and strips hub credentials upstream",
  () =>
    Effect.gen(function* () {
      const hub = yield* startHub();
      const session = yield* hub.auth.issueSession({ scopes: phoneScopes });
      const url = `${yield* ticketUrl(hub, session)}&token=hub-token&access_token=hub-access&credential=hub-secret&clientSurface=mobile&connectionMethod=hub-proxy`;
      const client = yield* makeRpcClient(url);
      const output = yield* Queue.unbounded<string>();
      yield* client["orchestration.subscribeThread"]().pipe(
        Stream.runForEach((value) => Queue.offer(output, value)),
        Effect.forkScoped,
      );
      expect(yield* Queue.take(output)).toBe("node-stream-value");
      const error = yield* Effect.flip(client["orchestration.dispatchCommand"]());
      expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
      expect(error).toMatchObject({ requiredScope: "orchestration:operate" });
      expect(hub.node.tags).toEqual(["orchestration.subscribeThread"]);
      expect(hub.node.handshakes).toHaveLength(1);
      expect(hub.node.handshakes[0]).toEqual({
        url: "/ws?orchestrationProtocol=1001&clientSurface=mobile&connectionMethod=hub-proxy",
        authorization: `Bearer ${NODE_TOKEN}`,
      });
      expect(JSON.stringify([yield* Queue.clear(output), error, url])).not.toContain(NODE_TOKEN);
    }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect("T6: a real batched WebSocket frame forwards only the admitted request", () =>
  Effect.gen(function* () {
    const hub = yield* startHub();
    const session = yield* hub.auth.issueSession({ scopes: phoneScopes });
    const client = yield* rawSocket(yield* ticketUrl(hub, session));
    yield* client.opened;
    client.socket.send(
      JSON.stringify([
        {
          _tag: "Request",
          id: 11,
          tag: "orchestration.subscribeThread",
          payload: null,
          headers: [],
        },
        {
          _tag: "Request",
          id: "12",
          tag: "orchestration.dispatchCommand",
          payload: null,
          headers: [],
        },
      ]),
    );
    const frames: Array<string> = [];
    let sawRefusal = false;
    let sawChunk = false;
    while (!sawRefusal || !sawChunk) {
      const frame = yield* Queue.take(client.frames);
      frames.push(frame);
      const parsed: unknown = JSON.parse(frame);
      for (const reply of Array.isArray(parsed) ? parsed : [parsed]) {
        if (reply._tag === "Exit" && reply.requestId === "12") {
          expect(reply.exit).toMatchObject({
            _tag: "Failure",
            cause: [{ _tag: "Fail", error: { requiredScope: "orchestration:operate" } }],
          });
          sawRefusal = true;
        }
        if (reply._tag === "Chunk" && reply.requestId === 11) sawChunk = true;
      }
    }
    expect(hub.node.tags).toEqual(["orchestration.subscribeThread"]);
    expect(frames.join("")).not.toContain(NODE_TOKEN);
  }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect(
  "T5/F1: terminates auth locally, strips node response secrets, caches shell, and authorizes snapshot hits",
  () =>
    Effect.gen(function* () {
      const hub = yield* startHub();
      const session = yield* hub.auth.issueSession({
        scopes: ["hub:proxy", "orchestration:read", "orchestration:operate", "settings:write"],
      });
      const path = `${hub.baseUrl}hub/nodes/node-1/`;
      const shell = yield* fetchResponse(`${path}api/orchestration/shell`, session.token);
      expect(shell.status).toBe(200);
      expect(hub.node.requests[0]?.authorization).toBe(`Bearer ${NODE_TOKEN}`);
      expect(shell.headers).not.toHaveProperty("set-cookie");
      expect(shell.headers).not.toHaveProperty("location");
      const snapshot = yield* fetchResponse(`${path}snapshot`, session.token);
      expect(snapshot.status).toBe(200);
      expect(JSON.parse(snapshot.text)).toMatchObject({
        nodeId: "node-1",
        shell: JSON.parse(shell.text),
      });
      const state = yield* fetchResponse(`${path}api/auth/session`, session.token);
      expect(state.status).toBe(200);
      expect(JSON.parse(state.text)).toMatchObject({
        authenticated: true,
        // Within the ceiling: settings:write never reaches a node through the hub.
        scopes: ["orchestration:read", "orchestration:operate"],
        permissions: ["orchestration:read", "orchestration:operate"],
        proxiedByHub: true,
      });
      const ticket = yield* fetchResponse(
        `${path}api/auth/websocket-ticket`,
        session.token,
        "POST",
      );
      expect(ticket.status).toBe(200);
      const ticketBody = JSON.parse(ticket.text);
      const store = hub.sessionStore;
      expect((yield* store.verifyWebSocketToken(ticketBody.ticket)).sessionId).toBe(
        session.sessionId,
      );
      expect(hub.node.requests.map((request) => request.url)).toEqual(["/api/orchestration/shell"]);
      const onlyProxy = yield* hub.auth.issueSession({ scopes: ["hub:proxy"] });
      expect((yield* fetchResponse(`${path}snapshot`, onlyProxy.token)).status).toBe(403);
      const responses = [shell, snapshot, state, ticket];
      expect(JSON.stringify(responses)).not.toContain(NODE_TOKEN);
      expect(JSON.stringify(responses)).not.toContain(NODE_SENTINEL);
    }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect("T13: paths outside the allowlist never reach the node", () =>
  Effect.gen(function* () {
    const hub = yield* startHub();
    const session = yield* hub.auth.issueSession({ scopes: phoneScopes });
    for (const path of [
      "api/auth/pairing-token",
      "api/auth/websocket-ticket",
      ".well-known/goat/activity",
      "mcp",
    ]) {
      const response = yield* fetchResponse(
        `${hub.baseUrl}hub/nodes/node-1/${path}`,
        session.token,
      );
      expect(response.status, path).toBe(404);
      expect(response.text).not.toContain(NODE_SENTINEL);
    }
    expect(hub.node.requests).toEqual([]);
    expect(hub.ssh.endpoints).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect.each(["upstream close", "session revocation", "node removal"] as const)(
  "lifecycle: %s closes an established relay",
  (trigger) =>
    Effect.gen(function* () {
      const hub = yield* startHub();
      const session = yield* hub.auth.issueSession({ scopes: phoneScopes });
      const client = yield* rawSocket(yield* ticketUrl(hub, session));
      yield* client.opened;
      client.socket.send(
        JSON.stringify({
          _tag: "Request",
          id: 1,
          tag: "orchestration.subscribeThread",
          payload: null,
          headers: [],
        }),
      );
      yield* Queue.take(client.frames);
      if (trigger === "upstream close") yield* hub.node.closeUpstream;
      else if (trigger === "session revocation")
        expect(yield* hub.sessionStore.revoke(session.sessionId)).toBe(true);
      else yield* hub.nodes.replace(undefined);
      yield* client.closed;
      yield* Queue.take(hub.node.streamEnded);
      if (trigger === "node removal") {
        expect(
          (yield* fetchResponse(`${hub.baseUrl}hub/nodes/node-1/snapshot`, session.token)).status,
        ).toBe(404);
        expect(
          (yield* fetchResponse(
            `${hub.baseUrl}hub/nodes/node-1/api/orchestration/shell`,
            session.token,
          )).status,
        ).toBe(404);
      }
    }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect("hub:proxy is required even with every standard scope, before any node work", () =>
  Effect.gen(function* () {
    const hub = yield* startHub();
    const session = yield* hub.auth.issueSession({ scopes: AuthStandardClientScopes });
    const shell = yield* fetchResponse(
      `${hub.baseUrl}hub/nodes/node-1/api/orchestration/shell`,
      session.token,
    );
    expect(shell.status).toBe(403);
    expect(JSON.parse(shell.text)).toMatchObject({ requiredScope: "hub:proxy" });
    expect(AuthStandardClientScopes).not.toContain("hub:proxy");
    expect(hub.ssh.endpoints).toHaveLength(0);
    expect(hub.ssh.issues).toHaveLength(0);
    expect(hub.node.requests).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect("F12: an upstream open failure returns HTTP 503 before any client upgrade", () =>
  Effect.gen(function* () {
    const hub = yield* startHub();
    hub.node.rejectUpgrade();
    const session = yield* hub.auth.issueSession({ scopes: phoneScopes });
    const client = yield* rawSocket(yield* ticketUrl(hub, session));
    expect(yield* client.failed).toBe(503);
    expect(client.socket.readyState).not.toBe(NodeWS.WebSocket.OPEN);
    expect(hub.node.requests.filter((request) => request.url.startsWith("/ws"))).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect("R3: a held shell body cannot restore the snapshot after unenrollment", () =>
  Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const body = Stream.concat(
      Stream.make(new TextEncoder().encode('{"projects":')),
      Stream.fromEffect(
        Deferred.succeed(held, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(new TextEncoder().encode('[],"threads":[]}')),
        ),
      ),
    );
    const hub = yield* startHub({ linked: true, shellBody: body });
    const session = yield* hub.auth.issueSession({ scopes: phoneScopes });
    const response = yield* fetchResponse(
      `${hub.baseUrl}hub/nodes/node-1/api/orchestration/shell`,
      session.token,
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(held);
    yield* hub.sessions.unenroll("node-1");
    expect(Option.isNone(yield* hub.sessions.snapshot("node-1"))).toBe(true);
    yield* Deferred.succeed(release, undefined);
    expect((yield* Fiber.join(response)).status).toBe(200);
    expect(Option.isNone(yield* hub.sessions.snapshot("node-1"))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect("R4: streams an oversized shell before its end without retaining a snapshot", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const body = Stream.concat(
      Stream.range(1, 5).pipe(Stream.map(() => new Uint8Array(1024 * 1024).fill(97))),
      Stream.fromEffect(Deferred.await(release).pipe(Effect.as(new Uint8Array([98])))),
    );
    const hub = yield* startHub({ shellBody: body });
    const session = yield* hub.auth.issueSession({ scopes: phoneScopes });
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.get(`${hub.baseUrl}hub/nodes/node-1/api/orchestration/shell`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    const received = yield* Deferred.make<void>();
    let bytes = 0;
    const read = yield* response.stream.pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          bytes += chunk.byteLength;
          if (bytes >= 5 * 1024 * 1024) yield* Deferred.succeed(received, undefined);
        }),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(received);
    expect(Option.isNone(yield* hub.sessions.snapshot("node-1"))).toBe(true);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(read);
    expect(bytes).toBe(5 * 1024 * 1024 + 1);
    expect(Option.isNone(yield* hub.sessions.snapshot("node-1"))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide([authLayer, FetchHttpClient.layer])),
);

it.effect("R5: capability assets require a cached session and never dial or load enrollment", () =>
  Effect.gen(function* () {
    const hub = yield* startHub({ linked: true });
    const url = `${hub.baseUrl}hub/nodes/node-1/api/assets/signed-capability/image.png`;
    expect((yield* fetchResponse(url)).status).toBe(404);
    expect(hub.secretReads()).toBe(0);
    expect(hub.ssh.endpoints).toHaveLength(0);
    expect(hub.ssh.issues).toHaveLength(0);
    yield* hub.sessions.open("node-1", readScopes);
    const reads = hub.secretReads();
    const asset = yield* fetchResponse(`${url}?wsTicket=HUB_SECRET&token=HUB_SECRET`);
    expect(asset.status).toBe(200);
    expect(hub.node.requests).toEqual([
      { url: "/api/assets/signed-capability/image.png", authorization: `Bearer ${NODE_TOKEN}` },
    ]);
    expect(asset.headers).not.toHaveProperty("set-cookie");
    expect(asset.headers).not.toHaveProperty("location");
    expect(hub.secretReads()).toBe(reads);
    yield* hub.sessions.unenroll("node-1");
    expect((yield* fetchResponse(url)).status).toBe(404);
    expect(hub.node.requests).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect.each(["expired", "removed"] as const)(
  "R5: %s cached sessions cannot serve capability assets",
  (change) =>
    Effect.gen(function* () {
      const hub = yield* startHub();
      yield* hub.sessions.open("node-1", readScopes);
      if (change === "expired") yield* TestClock.adjust("12 hours");
      else yield* hub.nodes.replace(undefined);
      expect(
        (yield* fetchResponse(`${hub.baseUrl}hub/nodes/node-1/api/assets/cap/image.png`)).status,
      ).toBe(404);
      expect(hub.ssh.issues).toHaveLength(1);
      expect(hub.node.requests).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect("S1: a linked HTTP 401 rejects enrollment and never retries the same token", () =>
  Effect.gen(function* () {
    const hub = yield* startHub({ linked: true });
    hub.node.rejectReads();
    const session = yield* hub.auth.issueSession({ scopes: phoneScopes });
    for (let i = 0; i < 2; i++) {
      const response = yield* fetchResponse(
        `${hub.baseUrl}hub/nodes/node-1/api/orchestration/shell`,
        session.token,
      );
      expect(response.status).toBe(403);
      expect(JSON.parse(response.text)).toMatchObject({ code: "hub_node_enrollment_required" });
    }
    expect(hub.node.requests).toHaveLength(1);
    expect(
      (yield* fetchResponse(`${hub.baseUrl}hub/nodes/node-1/api/assets/cap/image.png`)).status,
    ).toBe(404);
  }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect(
  "S1: a linked WS 401 rejects enrollment before any upgrade and subsequent opens return 403",
  () =>
    Effect.gen(function* () {
      const hub = yield* startHub({ linked: true });
      hub.node.rejectUpgrade(401);
      const session = yield* hub.auth.issueSession({ scopes: phoneScopes });
      const client = yield* rawSocket(yield* ticketUrl(hub, session));
      expect(yield* client.failed).toBe(403);
      expect(JSON.parse(yield* client.failureBody)).toMatchObject({
        code: "hub_node_enrollment_required",
      });
      expect(client.socket.readyState).not.toBe(NodeWS.WebSocket.OPEN);
      const response = yield* fetchResponse(
        `${hub.baseUrl}hub/nodes/node-1/api/orchestration/shell`,
        session.token,
      );
      expect(response.status).toBe(403);
      expect(JSON.parse(response.text)).toMatchObject({ code: "hub_node_enrollment_required" });
      expect(hub.node.requests).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect("S1: SSH keeps one fresh-session retry after HTTP and WS refusal", () =>
  Effect.gen(function* () {
    const hub = yield* startHub();
    hub.node.rejectReads();
    const session = yield* hub.auth.issueSession({ scopes: phoneScopes });
    const response = yield* fetchResponse(
      `${hub.baseUrl}hub/nodes/node-1/api/orchestration/shell`,
      session.token,
    );
    expect(response.status).toBe(401);
    expect(hub.ssh.issues).toHaveLength(2);
    hub.node.rejectUpgrade(401);
    const client = yield* rawSocket(yield* ticketUrl(hub, session));
    expect(yield* client.failed).toBe(503);
    expect(hub.node.requests.filter((request) => request.url.startsWith("/ws"))).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect("R5: a cached session without orchestration:read cannot serve capability assets", () =>
  Effect.gen(function* () {
    const hub = yield* startHub();
    yield* hub.sessions.open("node-1", ["orchestration:operate"]);
    expect(
      (yield* fetchResponse(`${hub.baseUrl}hub/nodes/node-1/api/assets/cap/image.png`)).status,
    ).toBe(404);
    expect(hub.ssh.issues).toHaveLength(1);
    expect(hub.node.requests).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect.each([
  ["page.html", "sandbox allow-scripts allow-forms allow-popups allow-downloads"],
  ["image.svg", "default-src 'none'; style-src 'unsafe-inline'; sandbox"],
  ["image.png", "default-src 'none'; sandbox"],
] as const)("N1: %s from a node keeps the hub's own sandbox, never the node's", ([file, policy]) =>
  Effect.gen(function* () {
    const hub = yield* startHub();
    yield* hub.sessions.open("node-1", readScopes);
    const asset = yield* fetchResponse(`${hub.baseUrl}hub/nodes/node-1/api/assets/cap/${file}`);
    expect(asset.status).toBe(200);
    expect(asset.headers["content-security-policy"]).toBe(policy);
    expect(asset.headers["content-security-policy"]).not.toContain("allow-same-origin");
    expect(asset.headers["x-content-type-options"]).toBe("nosniff");
  }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect("4b: signed uploads need a cached operate session and never dial for strangers", () =>
  Effect.gen(function* () {
    const hub = yield* startHub();
    const url = `${hub.baseUrl}hub/nodes/node-1/api/attachments/upload/signed-upload`;
    const post = () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.execute(
          HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText("bytes", "image/png")),
        );
      }).pipe(Effect.provide(FetchHttpClient.layer));
    expect((yield* post()).status).toBe(404);
    yield* hub.sessions.open("node-1", readScopes);
    // A read-only session may load assets but not upload.
    expect((yield* post()).status).toBe(404);
    expect(hub.ssh.endpoints).toHaveLength(1);
    yield* hub.sessions.open("node-1", ["orchestration:read", "orchestration:operate"]);
    const uploaded = yield* post();
    expect(uploaded.status).toBe(200);
    expect(uploaded.headers["x-content-type-options"]).toBe("nosniff");
    expect(hub.node.requests).toEqual([
      { url: "/api/attachments/upload/signed-upload", authorization: `Bearer ${NODE_TOKEN}` },
    ]);
  }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect(
  "S2: a read-only linked enrollment narrows session state and refuses operate WS calls locally",
  () =>
    Effect.gen(function* () {
      const hub = yield* startHub({ linked: true });
      const phone = yield* hub.auth.issueSession({
        scopes: ["hub:proxy", "orchestration:read", "orchestration:operate"],
      });
      const state = yield* fetchResponse(
        `${hub.baseUrl}hub/nodes/node-1/api/auth/session`,
        phone.token,
      );
      expect(state.status).toBe(200);
      expect(JSON.parse(state.text)).toMatchObject({
        authenticated: true,
        scopes: ["orchestration:read"],
        permissions: ["orchestration:read"],
        proxiedByHub: true,
      });
      expect(hub.node.requests).toEqual([]);
      expect(hub.ssh.issues).toEqual([]);
      const client = yield* rawSocket(yield* ticketUrl(hub, phone));
      yield* client.opened;
      client.socket.send(
        JSON.stringify({
          _tag: "Request",
          id: "operate",
          tag: "orchestration.dispatchCommand",
          headers: [],
          payload: {
            type: "message.dispatch",
            commandId: "c1",
            threadId: "t1",
            messageId: "m1",
            createdBy: "user",
            creationSource: "mobile",
            text: "Continue",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          },
        }),
      );
      const reply = JSON.parse(yield* Queue.take(client.frames));
      expect(Array.isArray(reply) ? reply : [reply]).toMatchObject([
        {
          _tag: "Exit",
          requestId: "operate",
          exit: {
            _tag: "Failure",
            cause: [{ _tag: "Fail", error: { requiredScope: "orchestration:operate" } }],
          },
        },
      ]);
      expect(hub.node.tags).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

const uploadUrl = (hub: Effect.Success<ReturnType<typeof startHub>>) =>
  `${hub.baseUrl}hub/nodes/node-1/api/attachments/upload/signed-upload`;
const postUpload = (
  hub: Effect.Success<ReturnType<typeof startHub>>,
  body = Stream.make(new TextEncoder().encode("bytes")),
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      HttpClientRequest.post(uploadUrl(hub)).pipe(
        HttpClientRequest.bodyStream(body, { contentType: "application/octet-stream" }),
      ),
    );
    return { status: response.status, text: yield* response.text };
  }).pipe(Effect.provide(FetchHttpClient.layer));

const uploadHub = Effect.fnUntraced(function* () {
  const hub = yield* startHub({ holdUploads: true });
  yield* hub.sessions.open("node-1", ["orchestration:read", "orchestration:operate"]);
  return hub;
});

it.effect("S4: declared upload length above the cap returns 403 without contacting the node", () =>
  Effect.gen(function* () {
    const hub = yield* uploadHub();
    const status = yield* Effect.callback<number, Error>((resume) => {
      const request = NodeHttp.request(
        uploadUrl(hub),
        {
          method: "POST",
          headers: { "content-length": PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 },
        },
        (response) => {
          response.resume();
          response.on("end", () => resume(Effect.succeed(response.statusCode ?? 0)));
        },
      );
      request.on("error", (error) => resume(Effect.fail(error)));
      request.end();
      return Effect.sync(() => request.destroy());
    });
    expect(status).toBe(403);
    expect(hub.node.requests).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect("S4: a chunked upload crossing the byte cap is refused and aborts the node request", () =>
  Effect.gen(function* () {
    const hub = yield* uploadHub();
    const chunk = new Uint8Array(1024 * 1024);
    const overflow = Effect.gen(function* () {
      let received = 0;
      while (received < PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
        received = yield* Queue.take(hub.node.uploadProgress);
      }
      return new Uint8Array([1]);
    });
    const body = Stream.range(1, 50).pipe(
      Stream.map(() => chunk),
      Stream.concat(Stream.fromEffect(overflow)),
    );
    const result = yield* Effect.result(postUpload(hub, body));
    if (result._tag === "Success") {
      expect(result.success.status).toBe(403);
      expect(JSON.parse(result.success.text)).toMatchObject({ code: "hub_node_refused" });
    } else {
      // Cancelling the inbound stream can close its socket before the refusal response is written.
      expect(result.failure.reason._tag).toBe("TransportError");
      expect(result.failure.reason.cause).toBeInstanceOf(TypeError);
      expect((result.failure.reason.cause as Error).cause).toMatchObject({
        code: expect.stringMatching(/^(?:ECONNRESET|UND_ERR_SOCKET)$/),
      });
    }
    expect(yield* Queue.take(hub.node.uploadAborted)).toBe(PROVIDER_SEND_TURN_MAX_FILE_BYTES);
    expect(hub.node.uploadLengths).toEqual([undefined]);
    expect(yield* Queue.size(hub.node.uploadReceived)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect(
  "S4: a stalled upload times out after ten minutes, aborts upstream and releases its slot",
  () =>
    Effect.gen(function* () {
      const hub = yield* uploadHub();
      const stalled = yield* postUpload(hub).pipe(Effect.forkScoped);
      expect(yield* Queue.take(hub.node.uploadReceived)).toBe(5);
      yield* TestClock.adjust("10 minutes");
      expect((yield* Fiber.join(stalled)).status).toBe(503);
      yield* Queue.take(hub.node.uploadAborted);
      const next = yield* Effect.forEach([1, 2, 3, 4], () =>
        postUpload(hub).pipe(Effect.forkScoped),
      );
      for (const _ of next) expect(yield* Queue.take(hub.node.uploadReceived)).toBe(5);
      yield* hub.node.releaseUploads;
      expect((yield* Effect.forEach(next, Fiber.join)).map((response) => response.status)).toEqual([
        200, 200, 200, 200,
      ]);
    }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect("S4: removing a node ends its held upload and aborts the upstream request", () =>
  Effect.gen(function* () {
    const hub = yield* uploadHub();
    const upload = yield* postUpload(hub).pipe(Effect.forkScoped);
    expect(yield* Queue.take(hub.node.uploadReceived)).toBe(5);
    yield* hub.nodes.replace(undefined);
    expect((yield* Fiber.join(upload)).status).toBe(503);
    yield* Queue.take(hub.node.uploadAborted);
  }).pipe(Effect.scoped, Effect.provide(authLayer)),
);

it.effect("S4: four Deferred-held uploads fill one node's slots and the fifth returns 429", () =>
  Effect.gen(function* () {
    const hub = yield* uploadHub();
    const held = yield* Effect.forEach([1, 2, 3, 4], () => postUpload(hub).pipe(Effect.forkScoped));
    for (const _ of held) expect(yield* Queue.take(hub.node.uploadReceived)).toBe(5);
    expect((yield* postUpload(hub)).status).toBe(429);
    expect(
      hub.node.requests.filter((request) => request.url.startsWith("/api/attachments/upload/")),
    ).toHaveLength(4);
    yield* hub.node.releaseUploads;
    expect((yield* Effect.forEach(held, Fiber.join)).map((response) => response.status)).toEqual([
      200, 200, 200, 200,
    ]);
    expect((yield* postUpload(hub)).status).toBe(200);
  }).pipe(Effect.scoped, Effect.provide(authLayer)),
);
