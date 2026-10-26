/**
 * `/hub/nodes/<nodeId>/*`: a client paired to this hub reaches a node's own API here. The hub
 * authenticates the client with its own session, answers auth endpoints itself, and calls the
 * node with a session only the hub holds, so node credentials never reach the client. See
 * docs/internals/hub-proxy.md for the threat model.
 */
import {
  AuthHubProxyScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionState,
  AuthWebSocketTicketResult,
  HUB_PROXY_ROUTE_PREFIX,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  authScopeResponse,
  hubProxyEffectiveScopes,
  type AuthEnvironmentScope,
} from "@goat/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { HTML_CONTENT_SECURITY_POLICY, SVG_CONTENT_SECURITY_POLICY } from "../http.ts";
import { type RelaySink, relay, relaySink, webSocketOfTransport } from "./relay.ts";
import { HubProxyNodes } from "./HubProxyNodes.ts";
import { makeSnapshotBuffer } from "./snapshotBuffer.ts";
import {
  HubProxyError,
  HubProxySessions,
  SNAPSHOT_MAX_BYTES,
  type HubProxyUpstream,
} from "./HubProxySessions.ts";

/** Node paths a client reads through the hub. Everything else under a node is not served. */
const READ_PATHS: ReadonlyArray<RegExp> = [
  /^api\/orchestration\/shell$/u,
  /^api\/orchestration\/threads\/[^/]+(\/(bounded|history|transcript))?$/u,
  /^api\/projects$/u,
  /^api\/assets\/[^/]+\/[^/]+$/u,
];
const DESCRIPTOR_PATHS = new Set([".well-known/goat/environment", ".well-known/t3/environment"]);
const ASSET_PATH = /^api\/assets\/[^/]+\/[^/]+$/u;
/** Signed upload URL a node minted for attachments.createUploadUrl; the token is the capability. */
const UPLOAD_PATH = /^api\/attachments\/upload\/[^/]+$/u;
const SHELL_PATH = "api/orchestration/shell";

/** Request headers that describe the call itself; credentials and hop headers are never copied. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "if-none-match",
  "if-modified-since",
  "range",
  "content-type",
  "x-goat-orchestration-protocol",
  "x-t3-orchestration-protocol",
];
/** Response headers a client may see. Set-Cookie and Location from a node never pass. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "etag",
  "last-modified",
  "content-range",
  "accept-ranges",
  "content-disposition",
];
/** Query parameters that carry this hub's credentials, not the node's. */
const CREDENTIAL_QUERY_PARAMS = new Set(["wsTicket", "token", "access_token"]);

/**
 * Node content is served on the hub's origin, so the hub sets the sandbox itself instead of
 * trusting a node's headers: the same policies as this server's own asset route, and an opaque
 * origin for everything else, so a node document can never call the hub with its cookies.
 */
const proxiedDocumentPolicy = (contentType: string | undefined): Record<string, string> => {
  const type = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return {
    "x-content-type-options": "nosniff",
    "content-security-policy":
      type === "text/html"
        ? HTML_CONTENT_SECURITY_POLICY
        : type === "image/svg+xml"
          ? SVG_CONTENT_SECURITY_POLICY
          : "default-src 'none'; sandbox",
  };
};

const FORWARDED_WEBSOCKET_QUERY_PARAMS = new Set([
  "orchestrationProtocol",
  "clientSurface",
  "clientAppVersion",
  "clientDeviceType",
  "clientOs",
  "clientWebDeployment",
  "clientBrowser",
  "clientOsMajorVersion",
  "clientDeviceModel",
  "connectionMethod",
]);

const upstreamSearch = (url: URL, allowed?: ReadonlySet<string>) => {
  const params = new URLSearchParams();
  for (const [name, value] of url.searchParams) {
    if (!CREDENTIAL_QUERY_PARAMS.has(name) && (allowed === undefined || allowed.has(name)))
      params.append(name, value);
  }
  return params.size > 0 ? `?${params.toString()}` : "";
};

const encodeSessionState = Schema.encodeEffect(AuthSessionState);
const encodeWebSocketTicket = Schema.encodeEffect(AuthWebSocketTicketResult);
const decodeSnapshotShell = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const unavailableResponse = (message: string) =>
  HttpServerResponse.jsonUnsafe({ code: "hub_node_unavailable", message }, { status: 503 });

const errorResponse = (error: HubProxyError) => {
  switch (error.reason) {
    case "not_found":
      return HttpServerResponse.text("Not Found", { status: 404 });
    case "unavailable":
      return unavailableResponse(error.message);
    case "enrollment_required":
    case "refused":
      return HttpServerResponse.jsonUnsafe(
        { code: `hub_node_${error.reason}`, message: error.message },
        { status: 403 },
      );
  }
};

const parseNodePath = (pathname: string) => {
  const rest = pathname.slice(HUB_PROXY_ROUTE_PREFIX.length + 1);
  const slash = rest.indexOf("/");
  const encoded = slash < 0 ? rest : rest.slice(0, slash);
  try {
    const nodeId = decodeURIComponent(encoded);
    return nodeId.length === 0
      ? undefined
      : { nodeId, path: slash < 0 ? "" : rest.slice(slash + 1) };
  } catch {
    return undefined;
  }
};

const authenticate = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    // The upgrade authenticator also reads cookies and Authorization, and accepts the hub's
    // own wsTicket for sockets and media that cannot set headers.
    // Bound tickets name their route: node sockets take an RPC ticket, assets a media one.
    const use = request.headers.upgrade?.toLowerCase() === "websocket" ? "rpc" : "media";
    const session = yield* serverAuth.authenticateWebSocketUpgrade(request, use).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(AuthHubProxyScope))
      return yield* failEnvironmentScopeRequired(AuthHubProxyScope);
    return session;
  });

const send = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const http = HttpClient.withScope(yield* HttpClient.HttpClient);
    return yield* http.execute(request).pipe(
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
      }),
    );
  });

const upstreamRequest = (
  request: HttpServerRequest.HttpServerRequest,
  upstream: HubProxyUpstream,
  pathAndSearch: string,
) => {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  headers.authorization = `Bearer ${upstream.token}`;
  return HttpClientRequest.make(request.method === "HEAD" ? "HEAD" : "GET")(
    new URL(pathAndSearch, upstream.httpBaseUrl).toString(),
  ).pipe(HttpClientRequest.setHeaders(headers));
};

/**
 * Streams an attachment body to the node's signed upload URL with the hub's cached session. The
 * body is never buffered here; the node checks the token, size and type as it does for its own
 * clients.
 */
const UPLOAD_DEADLINE = Duration.minutes(10);

const uploadTooLarge = () =>
  new HubProxyError({
    reason: "refused",
    message: "That file is larger than an attachment may be.",
  });

const proxyUpload = Effect.fn("HubProxyHttp.proxyUpload")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstream: HubProxyUpstream,
  path: string,
) {
  const sessions = yield* HubProxySessions;
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isSafeInteger(contentLength) && contentLength > PROVIDER_SEND_TURN_MAX_FILE_BYTES)
    return yield* uploadTooLarge();
  let bytes = 0;
  // Counted as it streams, whatever the header claimed; nothing is buffered here.
  const body = request.stream.pipe(
    Stream.mapEffect((chunk) => {
      bytes += chunk.byteLength;
      return bytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES
        ? Effect.fail(uploadTooLarge())
        : Effect.succeed(chunk);
    }),
  );
  const slots = yield* sessions.uploadSlots(upstream.nodeId);
  const transfer = send(
    HttpClientRequest.post(new URL(path, upstream.httpBaseUrl).toString()).pipe(
      HttpClientRequest.setHeaders({ authorization: `Bearer ${upstream.token}` }),
      HttpClientRequest.bodyStream(body, {
        ...(request.headers["content-type"]
          ? { contentType: request.headers["content-type"] }
          : {}),
        ...(Number.isSafeInteger(contentLength) && contentLength >= 0 ? { contentLength } : {}),
      }),
    ),
  ).pipe(
    Effect.timeoutOption(UPLOAD_DEADLINE),
    // Removing the node or its enrollment ends an upload in flight too.
    (effect) =>
      Effect.raceFirst(
        effect,
        sessions.revoked(upstream.nodeId, upstream.generation).pipe(Effect.as(Option.none())),
      ),
    Effect.mapError(() =>
      bytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES
        ? uploadTooLarge()
        : new HubProxyError({ reason: "unavailable", message: "The node did not answer." }),
    ),
    Effect.scoped,
  );
  const outcome = yield* slots.withPermitsIfAvailable(1)(transfer);
  if (Option.isNone(outcome))
    return HttpServerResponse.text("Too many uploads to this machine at once.", { status: 429 });
  if (Option.isNone(outcome.value))
    return yield* new HubProxyError({
      reason: "unavailable",
      message: "The upload took too long.",
    });
  const response = outcome.value.value;
  return HttpServerResponse.empty({
    status: response.status,
    headers: proxiedDocumentPolicy(undefined),
  });
});

const proxyRead = Effect.fn("HubProxyHttp.proxyRead")(function* (
  request: HttpServerRequest.HttpServerRequest,
  nodeId: string,
  path: string,
  url: URL,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  cached?: HubProxyUpstream,
) {
  const sessions = yield* HubProxySessions;
  const pathAndSearch = `${path}${upstreamSearch(url)}`;
  const attempt = (
    retried: boolean,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HubProxyError,
    HttpClient.HttpClient | Scope.Scope
  > =>
    Effect.gen(function* () {
      const upstream = cached ?? (yield* sessions.open(nodeId, scopes));
      const response = yield* send(upstreamRequest(request, upstream, pathAndSearch)).pipe(
        Effect.mapError(
          () => new HubProxyError({ reason: "unavailable", message: "The node did not answer." }),
        ),
      );
      if (response.status === 401) {
        yield* sessions.invalidate(nodeId, upstream.token);
        if (cached !== undefined) return HttpServerResponse.text("Not Found", { status: 404 });
        if (!retried) return yield* attempt(true);
      }
      const headers: Record<string, string> = { "cache-control": "no-store" };
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = response.headers[name];
        if (value !== undefined) headers[name] = value;
      }
      Object.assign(headers, proxiedDocumentPolicy(headers["content-type"]));
      const stream =
        path === SHELL_PATH && request.method === "GET" && response.status === 200
          ? Stream.suspend(() => {
              const buffer = makeSnapshotBuffer(SNAPSHOT_MAX_BYTES);
              return response.stream.pipe(
                Stream.tap((chunk) => Effect.sync(() => buffer.append(chunk))),
                Stream.onEnd(
                  Effect.suspend(() => {
                    const body = buffer.body();
                    return body === undefined
                      ? Effect.void
                      : sessions.recordSnapshot(nodeId, body, upstream.generation);
                  }),
                ),
              );
            })
          : response.stream;
      return HttpServerResponse.stream(stream, {
        status: response.status,
        headers,
        ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
      });
    });
  return yield* attempt(false);
});

const openUpstreamSocket = (upstream: HubProxyUpstream, search: string) =>
  Effect.suspend(() => {
    let status: number | undefined;
    let ws: NodeSocket.NodeWS.WebSocket | undefined;
    return Effect.gen(function* () {
      const socket = yield* Socket.makeWebSocket(
        new URL(`ws${search}`, upstream.wsBaseUrl).toString(),
        { openTimeout: "10 seconds", headers: { authorization: `Bearer ${upstream.token}` } },
      );
      // Acquiring the reader waits for acceptance before the client is upgraded.
      const reader = yield* socket.reader;
      if (ws === undefined)
        return yield* new Socket.SocketError({
          reason: new Socket.SocketOpenError({
            kind: "Unknown",
            cause: new Error("The node socket is unavailable."),
          }),
        });
      return { reader, sink: relaySink(ws) };
    }).pipe(
      Effect.provideService(Socket.WebSocketConstructor, (url, options) => {
        const socket = new NodeSocket.NodeWS.WebSocket(
          url,
          typeof options === "object" && !Array.isArray(options) ? options.protocols : options,
          {
            headers:
              typeof options === "object" && !Array.isArray(options) ? options.headers : undefined,
          },
        );
        ws = socket;
        // ws exposes the HTTP status only on this event, not on SocketOpenError.
        socket.on("unexpected-response", (_request, response) => {
          status = response.statusCode;
          response.resume();
          socket.terminate();
        });
        return socket;
      }),
      Effect.mapError(() => ({ unauthorized: status === 401 })),
    );
  });

const proxySocket = Effect.fn("HubProxyHttp.proxySocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  session: EnvironmentAuth.AuthenticatedSession,
  nodeId: string,
  url: URL,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) {
  const sessions = yield* HubProxySessions;
  const sessionStore = yield* SessionStore.SessionStore;
  const search = upstreamSearch(url, FORWARDED_WEBSOCKET_QUERY_PARAMS);
  const connect = (
    retried: boolean,
  ): Effect.Effect<
    {
      readonly upstream: HubProxyUpstream;
      readonly socket: {
        readonly reader: Socket.Reader;
        readonly sink: RelaySink;
      };
    },
    HubProxyError,
    Scope.Scope
  > =>
    Effect.gen(function* () {
      const upstream = yield* sessions.open(nodeId, scopes);
      const opened = yield* Effect.result(openUpstreamSocket(upstream, search));
      if (opened._tag === "Success") return { upstream, socket: opened.success };
      yield* sessions.invalidate(nodeId, upstream.token, opened.failure.unauthorized);
      if (retried)
        return yield* new HubProxyError({
          reason: "unavailable",
          message: "The node refused the connection.",
        });
      return yield* connect(true);
    });
  const { upstream, socket } = yield* connect(false);
  if (!(yield* sessions.isCurrent(nodeId, upstream.generation)))
    return unavailableResponse("This node changed while the hub was connecting. Try again.");
  const client = yield* request.upgrade;
  yield* sessions.trackRelay(nodeId);
  const clientReader = yield* client.reader;
  // ws took over the request's TCP socket during the upgrade above.
  const clientSocket = webSocketOfTransport(
    (request.source as { readonly socket?: unknown }).socket,
  );
  // Relaying without a way to see what is queued could buffer without bound, so close instead.
  if (clientSocket === undefined) return HttpServerResponse.empty();
  const clientSink = relaySink(clientSocket);
  yield* relay({
    upstreamReader: socket.reader,
    upstream: socket.sink,
    clientReader,
    client: clientSink,
    // The node session's own scopes: for a linked node that is also within its enrollment.
    scopes: upstream.scopes,
    stop: [
      sessionStore.awaitInvalidation(session.sessionId),
      sessions.revoked(nodeId, upstream.generation),
    ],
  });
  return HttpServerResponse.empty();
});

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const target = parseNodePath(url.value.pathname);
  if (target === undefined) return HttpServerResponse.text("Not Found", { status: 404 });
  if ((request.method === "GET" || request.method === "HEAD") && ASSET_PATH.test(target.path)) {
    const sessions = yield* HubProxySessions;
    const cached = yield* sessions.peek(target.nodeId);
    if (Option.isNone(cached)) return HttpServerResponse.text("Not Found", { status: 404 });
    return yield* proxyRead(
      request,
      target.nodeId,
      target.path,
      url.value,
      cached.value.scopes,
      cached.value,
    ).pipe(
      Effect.catchTags({
        HubProxyError: () => Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 })),
      }),
    );
  }
  // Like assets, uploads are capability URLs clients send without a hub header; only a cached
  // session that may operate serves them, so an unauthenticated caller never makes the hub dial.
  if (request.method === "POST" && UPLOAD_PATH.test(target.path)) {
    const sessions = yield* HubProxySessions;
    const cached = yield* sessions.peek(target.nodeId, AuthOrchestrationOperateScope);
    if (Option.isNone(cached)) return HttpServerResponse.text("Not Found", { status: 404 });
    return yield* proxyUpload(request, cached.value, target.path).pipe(
      Effect.catchTags({ HubProxyError: (error) => Effect.succeed(errorResponse(error)) }),
    );
  }
  // Authentication precedes any operation that can acquire node authority or dial SSH.
  const session = yield* authenticate(request);
  const scopes = hubProxyEffectiveScopes(session.scopes);
  const nodes = yield* HubProxyNodes;
  if (Option.isNone(yield* nodes.get(target.nodeId)))
    return HttpServerResponse.text("Not Found", { status: 404 });
  const sessions = yield* HubProxySessions;
  const { path } = target;
  const reads = scopes.includes(AuthOrchestrationReadScope);

  if (path === "ws" && isWebSocketUpgrade(request)) {
    if (!reads) return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
    return yield* proxySocket(request, session, target.nodeId, url.value, scopes).pipe(
      Effect.catchTags({ HubProxyError: (error) => Effect.succeed(errorResponse(error)) }),
    );
  }
  if (path === "api/auth/session" && request.method === "GET") {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const state = yield* serverAuth.getSessionState(request);
    // What this client may do on the node: its own rights, within what the node granted the hub.
    const allowed = yield* sessions.limit(target.nodeId, scopes);
    const narrowed = state.authenticated
      ? { ...state, ...authScopeResponse(allowed), proxiedByHub: true }
      : state;
    return HttpServerResponse.jsonUnsafe(yield* encodeSessionState(narrowed).pipe(Effect.orDie));
  }
  if (path === "api/auth/websocket-ticket" && request.method === "POST") {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    // A ticket for this hub session: it opens P/ws here and is never accepted by a node.
    const ticket = yield* serverAuth
      .issueWebSocketTicket(session)
      .pipe(
        Effect.catch((error) => failEnvironmentInternal("websocket_ticket_issuance_failed", error)),
      );
    return HttpServerResponse.jsonUnsafe(yield* encodeWebSocketTicket(ticket).pipe(Effect.orDie));
  }
  if (request.method !== "GET" && request.method !== "HEAD")
    return HttpServerResponse.text("Not Found", { status: 404 });
  if (!reads) return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
  if (path === "snapshot") {
    const cached = yield* sessions.snapshot(target.nodeId);
    if (Option.isNone(cached)) return HttpServerResponse.text("Not Found", { status: 404 });
    const shell = yield* decodeSnapshotShell(cached.value.body).pipe(Effect.option);
    if (Option.isNone(shell)) return HttpServerResponse.text("Not Found", { status: 404 });
    return HttpServerResponse.jsonUnsafe(
      { nodeId: target.nodeId, capturedAt: cached.value.capturedAt, shell: shell.value },
      { headers: { "cache-control": "no-store" } },
    );
  }
  if (DESCRIPTOR_PATHS.has(path) || READ_PATHS.some((pattern) => pattern.test(path)))
    return yield* proxyRead(request, target.nodeId, path, url.value, scopes).pipe(
      Effect.catchTags({ HubProxyError: (error) => Effect.succeed(errorResponse(error)) }),
    );
  return HttpServerResponse.text("Not Found", { status: 404 });
});

export const layer = HttpRouter.add("*", `${HUB_PROXY_ROUTE_PREFIX}/*`, handler);
