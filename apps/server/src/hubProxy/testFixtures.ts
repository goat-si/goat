// @effect-diagnostics-next-line nodeBuiltinImport:off -- scoped ephemeral HTTP test servers.
import * as NodeHttp from "node:http";

import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  type AuthEnvironmentScope,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { SshRemoteDispatch } from "../sshRemote/SshRemoteDispatch.ts";
import { HubProxyNodes, type HubProxyNode } from "./HubProxyNodes.ts";
import * as HubProxySessions from "./HubProxySessions.ts";
import * as HubProxyHttp from "./http.ts";

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeEnrollmentFixture = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const NODE_TOKEN = "NODE_TOKEN-private-to-hub";
export const NODE_SENTINEL = "NODE_AUTH_SECRET-never-proxy";
export const readScopes = ["orchestration:read"] as const;
export const phoneScopes = ["hub:proxy", ...readScopes] as const;
export const sshNode: HubProxyNode = {
  nodeId: "node-1",
  environmentId: EnvironmentId.make("node-environment"),
  label: "Node",
  routes: [
    {
      kind: "ssh",
      target: { alias: "alias", hostname: "actual.host", username: "remote-user", port: 2201 },
    },
  ],
};
const group = RpcGroup.make(
  Rpc.make("orchestration.subscribeThread", {
    success: Schema.String,
    stream: true,
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make("orchestration.dispatchCommand", {
    success: Schema.String,
    error: EnvironmentAuthorizationError,
  }),
);

export const serve = Effect.fnUntraced(function* <E, R>(
  routes: Layer.Layer<never, E, R | HttpRouter.HttpRouter>,
) {
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(
        // Compression as the real server negotiates it, so relays see ws's compression queue.
        NodeHttpServer.layer(NodeHttp.createServer, {
          port: 0,
          host: "127.0.0.1",
          websocket: { perMessageDeflate: true },
        }),
      ),
    ),
  );
  return `${HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address)}/`;
});

export const makeNodes = Effect.fnUntraced(function* (initial: HubProxyNode = sshNode) {
  let current: HubProxyNode | undefined = initial;
  const changes = yield* Queue.unbounded<void>();
  const subscribed = yield* Queue.unbounded<void>();
  const service = HubProxyNodes.of({
    get: (id) => Effect.sync(() => (current?.nodeId === id ? Option.some(current) : Option.none())),
    changes: Stream.fromQueue(changes).pipe(Stream.onStart(Queue.offer(subscribed, undefined))),
    refreshIdentity: () => Effect.void,
  });
  return {
    service,
    subscribed: Queue.take(subscribed),
    replace: (node: HubProxyNode | undefined) =>
      Effect.sync(() => {
        current = node;
      }).pipe(Effect.andThen(Queue.offer(changes, undefined)), Effect.asVoid),
  };
});

export const makeSecrets = () => {
  const values = new Map<string, Uint8Array>();
  const service = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    create: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    getOrCreateRandom: () => Effect.die("Unexpected random secret request"),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  });
  return { values, service };
};

export const makeSsh = (
  baseUrl: string,
  options?: {
    readonly grants?: ReadonlyArray<AuthEnvironmentScope>;
    readonly uniqueTokens?: boolean;
  },
) => {
  const endpoints: Array<Parameters<SshRemoteDispatch["Service"]["proxyEndpoint"]>[0]> = [];
  const issues: Array<ReadonlyArray<AuthEnvironmentScope>> = [];
  let forward = baseUrl;
  const unused = () => Effect.die("Unexpected SSH operation");
  const service = SshRemoteDispatch.of({
    runtimeStatus: unused,
    runtimeUpdate: unused,
    beginSetupOperation: unused,
    prepareRuntime: unused,
    forgetRuntime: unused,
    publishSetupOutcome: unused,
    publishProviderDiagnosis: unused,
    runRemoteScript: unused,
    runHostScript: unused,
    preflightTarget: unused,
    identifyTarget: unused,
    listHosts: unused,
    browse: unused,
    validateLaunchAttachments: unused,
    launchThread: unused,
    callHostTool: unused,
    connectedHosts: Effect.succeed([]),
    proxyEndpoint: (target) =>
      Effect.sync(() => {
        endpoints.push(target);
        return { httpBaseUrl: forward, wsBaseUrl: forward.replace(/^http/u, "ws") };
      }),
    issueProxySession: (_target, scopes) =>
      Effect.gen(function* () {
        issues.push([...scopes]);
        return {
          token: options?.uniqueTokens ? `${NODE_TOKEN}-${issues.length}` : NODE_TOKEN,
          scopes: options?.grants ?? scopes,
          expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 12 })),
        };
      }),
  });
  return {
    service,
    endpoints,
    issues,
    /** A relaunched node's forward listens on a new local port. */
    moveForward: (url: string) => {
      forward = url;
    },
  };
};

export const makeSessions = Effect.fnUntraced(function* (
  nodes: HubProxyNodes["Service"],
  ssh: SshRemoteDispatch["Service"],
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  client?: HttpClient.HttpClient,
) {
  return yield* HubProxySessions.make.pipe(
    Effect.provideService(HubProxyNodes, nodes),
    Effect.provideService(SshRemoteDispatch, ssh),
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    client === undefined
      ? Effect.provide(FetchHttpClient.layer)
      : Effect.provideService(HttpClient.HttpClient, client),
  );
});

export const startNode = Effect.fnUntraced(function* (
  shellBody?: Stream.Stream<Uint8Array>,
  holdUploads = false,
) {
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const tags: Array<string> = [];
  const handshakes: Array<{ url: string; authorization: string | undefined }> = [];
  const sockets: Array<Socket.Socket> = [];
  const shellRequests = yield* Queue.unbounded<number>();
  const streamEnded = yield* Queue.unbounded<void>();
  const uploadStarted = yield* Queue.unbounded<void>();
  const uploadReceived = yield* Queue.unbounded<number>();
  const uploadAborted = yield* Queue.unbounded<number>();
  const uploadProgress = yield* Queue.unbounded<number>();
  const releaseUploads = yield* Deferred.make<void>();
  const uploadLengths: Array<string | undefined> = [];
  let rejectUpgrade = 0;
  let rejectReads = false;
  let shellCount = 0;
  const routes = Layer.unwrap(
    Effect.gen(function* () {
      const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
      yield* RpcServer.make(group).pipe(
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.provide(
          group.toLayer({
            "orchestration.subscribeThread": () =>
              Stream.concat(Stream.make("node-stream-value"), Stream.never).pipe(
                Stream.ensuring(Queue.offer(streamEnded, undefined)),
              ),
            "orchestration.dispatchCommand": () => Effect.succeed("NODE-WRITE-RAN"),
          }),
        ),
        Effect.forkScoped,
      );
      return HttpRouter.add(
        "*",
        "/*",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          requests.push({ url: request.url, authorization: request.headers.authorization });
          const path = request.url.split("?")[0];
          if (path === "/ws") {
            if (rejectUpgrade) return HttpServerResponse.empty({ status: rejectUpgrade });
            handshakes.push({ url: request.url, authorization: request.headers.authorization });
            const socket = yield* request.upgrade;
            sockets.push(socket);
            const observed = Socket.make({
              reader: socket.reader.pipe(
                Effect.map((reader) => ({
                  ...reader,
                  pull: reader.pull.pipe(
                    Effect.tap((frames) =>
                      Effect.sync(() => {
                        for (const frame of frames) {
                          const decoded = decodeFrame(
                            typeof frame === "string" ? frame : new TextDecoder().decode(frame),
                          );
                          for (const envelope of Array.isArray(decoded) ? decoded : [decoded]) {
                            if (envelope?._tag === "Request") tags.push(envelope.tag);
                          }
                        }
                      }),
                    ),
                  ),
                })),
              ),
              writer: socket.writer,
            });
            // Keep the real request's prototype (headers, URL, cookies) while replacing only its upgrade.
            const wrapped = Object.create(request) as HttpServerRequest.HttpServerRequest;
            Object.defineProperty(wrapped, "upgrade", { value: Effect.succeed(observed) });
            return yield* httpEffect.pipe(
              Effect.provideService(HttpServerRequest.HttpServerRequest, wrapped),
            );
          }
          if (holdUploads && path?.startsWith("/api/attachments/upload/")) {
            let bytes = 0;
            const response = NodeHttpServerRequest.toServerResponse(request);
            response.once("close", () => {
              if (!response.writableFinished) Queue.offerUnsafe(uploadAborted, bytes);
            });
            uploadLengths.push(request.headers["content-length"]);
            yield* Queue.offer(uploadStarted, undefined);
            yield* request.stream.pipe(
              Stream.runForEach((chunk) =>
                Effect.sync(() => {
                  bytes += chunk.byteLength;
                  Queue.offerUnsafe(uploadProgress, bytes);
                }),
              ),
            );
            yield* Queue.offer(uploadReceived, bytes);
            yield* Deferred.await(releaseUploads);
            return HttpServerResponse.empty({ status: 200 });
          }
          if (rejectReads) return HttpServerResponse.empty({ status: 401 });
          if (path === "/api/orchestration/shell") {
            shellCount += 1;
            yield* Queue.offer(shellRequests, shellCount);
            if (shellBody !== undefined)
              return HttpServerResponse.stream(shellBody, { contentType: "application/json" });
            return HttpServerResponse.jsonUnsafe(
              { snapshotSequence: shellCount, projects: [], threads: [] },
              {
                headers: {
                  "set-cookie": `node=${NODE_TOKEN}`,
                  location: `https://node.invalid/${NODE_TOKEN}`,
                },
              },
            );
          }
          if (path === "/.well-known/goat/environment")
            return HttpServerResponse.jsonUnsafe({ environmentId: sshNode.environmentId });
          // A hostile node asks for same-origin script access on the hub's origin.
          if (path?.endsWith(".html") || path?.endsWith(".svg"))
            return HttpServerResponse.text("<script>fetch('/api/auth/session')</script>", {
              contentType: path?.endsWith(".svg") ? "image/svg+xml" : "text/html",
              headers: { "content-security-policy": "sandbox allow-scripts allow-same-origin" },
            });
          return HttpServerResponse.text(NODE_SENTINEL, {
            headers: {
              "set-cookie": `node=${NODE_TOKEN}`,
              location: `https://node.invalid/${NODE_TOKEN}`,
            },
          });
        }),
      );
    }),
  ).pipe(Layer.provide(RpcSerialization.layerJson));
  const baseUrl = yield* serve(routes);
  return {
    baseUrl,
    requests,
    tags,
    handshakes,
    shellRequests,
    streamEnded,
    uploadStarted,
    uploadReceived,
    uploadAborted,
    uploadProgress,
    uploadLengths,
    releaseUploads: Deferred.succeed(releaseUploads, undefined).pipe(Effect.asVoid),
    rejectUpgrade: (status = 503) => {
      rejectUpgrade = status;
    },
    rejectReads: () => {
      rejectReads = true;
    },
    closeUpstream: Effect.gen(function* () {
      for (const socket of sockets) {
        const writer = yield* socket.writer;
        yield* writer.write(new Socket.CloseEvent(1000, "node closed"));
      }
    }),
  };
});

export const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-hub-proxy-test-" })),
  Layer.provide(NodeServices.layer),
);

export const startHub = Effect.fnUntraced(function* (options?: {
  readonly linked?: boolean;
  readonly holdUploads?: boolean;
  readonly shellBody?: Stream.Stream<Uint8Array>;
}) {
  const node = yield* startNode(options?.shellBody, options?.holdUploads);
  const nodes = yield* makeNodes(
    options?.linked
      ? { ...sshNode, routes: [{ kind: "linked", baseUrl: node.baseUrl.replace(/\/$/u, "") }] }
      : sshNode,
  );
  const ssh = makeSsh(node.baseUrl);
  const secrets = makeSecrets();
  let secretReads = 0;
  if (options?.linked)
    yield* secrets.service.set(
      HubProxySessions.enrollmentSecretName("node-1"),
      new TextEncoder().encode(
        yield* encodeEnrollmentFixture({
          version: 1,
          nodeId: "node-1",
          baseUrl: node.baseUrl.replace(/\/$/u, ""),
          token: NODE_TOKEN,
          scopes: readScopes,
          expiresAt: null,
        }),
      ),
    );
  const sessions = yield* makeSessions(nodes.service, ssh.service, {
    ...secrets.service,
    get: (name) =>
      Effect.suspend(() => {
        secretReads += 1;
        return secrets.service.get(name);
      }),
  });
  yield* nodes.subscribed;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessionStore = yield* SessionStore.SessionStore;
  const baseUrl = yield* serve(HubProxyHttp.layer).pipe(
    Effect.provideService(HubProxyNodes, nodes.service),
    Effect.provideService(HubProxySessions.HubProxySessions, sessions),
    Effect.provide(FetchHttpClient.layer),
  );
  return {
    node,
    nodes,
    ssh,
    secrets,
    sessions,
    auth,
    baseUrl,
    sessionStore,
    secretReads: () => secretReads,
  };
});

export const makeRpcClient = Effect.fnUntraced(function* (url: string) {
  const socket = yield* Socket.makeWebSocket(url).pipe(
    Effect.provide(NodeSocket.layerWebSocketConstructorWS),
  );
  const protocol = yield* RpcClient.makeProtocolSocket({ retryTransientErrors: false }).pipe(
    Effect.provideService(Socket.Socket, socket),
    Effect.provide(RpcSerialization.layerJson),
  );
  return yield* RpcClient.make(group).pipe(Effect.provideService(RpcClient.Protocol, protocol));
});
