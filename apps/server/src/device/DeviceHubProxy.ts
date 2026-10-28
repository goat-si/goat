// Loopback-only hubs expose shell execution or unauthenticated actions.
// Proxy with environment read scope for streams and operate scope for input and tuning.
import { AuthOrchestrationReadScope, AuthOrchestrationOperateScope } from "@goat/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as Lifetime from "../auth/SessionSocketLifetime.ts";
import * as DeviceService from "./DeviceService.ts";
import * as WebRtcPeers from "./deviceWebRtcPeers.ts";
import { repeatStillFrame } from "./mjpegStillFrame.ts";

const ALLOWED_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/devices$/,
  /^\/vendor\/serve-sim\/api$/,
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-sim\/api\/event-log(\/events)?$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/(stream\.mjpeg|stream\.avcc|config|health|ax|foreground)$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/panel\/(1|3)\/stream\.avcc$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/webrtc\/(offer|close)$/,
  /^\/vendor\/serve-sim\/appstate$/,
  /^\/vendor\/serve-emu\/api\/(devices|screenshot|stream-mode|stream-settings|accessibility|fold)$/,
  /^\/vendor\/serve-emu\/health$/,
];

const MUTABLE_PATHS: ReadonlyArray<RegExp> = [
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  // WebRTC signalling: opening and closing a view of the stream, so read scope.
  /^\/vendor\/serve-sim\/helper\/[^/]+\/webrtc\/(offer|close)$/,
  /^\/vendor\/serve-emu\/api\/(screenshot|stream-mode|stream-settings)$/,
  /^\/vendor\/serve-emu\/api\/fold$/,
];

const ALLOWED_WS_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/devices\/ws$/,
  /^\/vendor\/serve-sim\/helper\/ws$/,
  /^\/vendor\/serve-emu\/ws$/,
];

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
  // The client's HTTPS hop makes the hub reject our loopback Origin over GOAT Connect.
  "x-forwarded-proto",
]);

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

const forwardHeaders = (request: HttpServerRequest.HttpServerRequest, origin: string) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  // serve-emu refuses mutations whose Origin differs from the request origin.
  if (request.headers.origin !== undefined) headers.origin = origin;
  return headers;
};

const proxyWebSocket = Effect.fn("DeviceHubProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  protocols: ReadonlyArray<string> = [],
) {
  const client = yield* request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
    ...(protocols.length > 0 ? { protocols: [...protocols] } : {}),
  }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.writer;
      return yield* Effect.raceFirst(
        pumpFrames(upstream, writeToClient),
        pumpFrames(client, writeToUpstream),
      );
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const pumpFrames =
  /* Frame pumping runs continuously; a span per frame stream adds no diagnostic value. */
  Effect.fnUntraced(function* (source: Socket.Socket, sink: Socket.Writer) {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

const proxyHttp = Effect.fn("DeviceHubProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  options: {
    readonly extraHeaders?: Readonly<Record<string, string>> | undefined;
    readonly body?: string;
    readonly stop: Effect.Effect<void>;
  },
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = request.method;
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders({
      ...forwardHeaders(request, new URL(upstreamUrl).origin),
      ...options.extraHeaders,
    }),
    method === "GET" || method === "HEAD"
      ? (self) => self
      : options.body !== undefined
        ? HttpClientRequest.bodyText(options.body, request.headers["content-type"])
        : // A bare stream body is sent as octet-stream; serve-sim refuses WebRTC
          // offers that are not application/json.
          HttpClientRequest.bodyStream(request.stream, {
            contentType: request.headers["content-type"],
          }),
  );
  const response = yield* httpClient.execute(upstreamRequest);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    // A cookie from an upstream such as an EAS session's preview host would land on GOAT's origin.
    if (
      name === "content-encoding" ||
      name === "transfer-encoding" ||
      name === "connection" ||
      name === "set-cookie"
    ) {
      continue;
    }
    if (value !== undefined) headers[name] = value;
  }
  // Long-lived MJPEG and AVCC responses must not be buffered by compression.
  headers["cache-control"] = "no-store, no-transform";
  // Live streams end with the authority of the session that opened them.
  const body = (
    headers["content-type"]?.startsWith("multipart/x-mixed-replace")
      ? repeatStillFrame(response.stream)
      : response.stream
  ).pipe(Stream.interruptWhen(options.stop));
  return HttpServerResponse.stream(body, {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

// SDP offers are a few kilobytes; a signalling body past this is refused while it is read.
const SIGNAL_MAX_BYTES = 64 * 1024;

class SignalTooLargeError extends Data.TaggedError("SignalTooLargeError") {}

const readSignal = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  yield* Stream.runForEach(request.stream, (chunk) => {
    size += chunk.byteLength;
    if (size > SIGNAL_MAX_BYTES) return Effect.fail(new SignalTooLargeError());
    chunks.push(chunk);
    return Effect.void;
  });
  return new TextDecoder().decode(Buffer.concat(chunks));
});
const WEBRTC_SIGNAL = /\/webrtc\/(offer|close)$/;

class WebRtcCloseRefusedError extends Data.TaggedError("WebRtcCloseRefusedError")<{
  readonly status: number;
}> {}

const closeWebRtc = (
  httpClient: HttpClient.HttpClient,
  offerUrl: string,
  headers: Readonly<Record<string, string>> | undefined,
  sessionId: string,
) => {
  const url = new URL(offerUrl);
  url.pathname = url.pathname.replace(/\/offer$/, "/close");
  return httpClient
    .execute(
      HttpClientRequest.post(url.toString()).pipe(
        HttpClientRequest.setHeaders({ ...headers }),
        HttpClientRequest.bodyText(JSON.stringify({ sessionId }), "application/json"),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        response.status < 300
          ? Effect.void
          : Effect.fail(new WebRtcCloseRefusedError({ status: response.status })),
      ),
      Effect.scoped,
    );
};

// The request span already covers each proxied device request.
const makeHandler = Effect.fnUntraced(function* (peers: ReturnType<typeof WebRtcPeers.make>) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const hubPath = url.value.pathname.slice(DeviceService.DEVICE_HUB_ROUTE_PREFIX.length) || "/";
  const upgrade = isWebSocketUpgrade(request);
  const allowed = (upgrade ? ALLOWED_WS_PATHS : ALLOWED_PATHS).some((pattern) =>
    pattern.test(hubPath),
  );
  if (!allowed) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const readOnly = request.method === "GET" || request.method === "HEAD";
  if (!upgrade && !readOnly && !MUTABLE_PATHS.some((pattern) => pattern.test(hubPath))) {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  const controlsDevice =
    (upgrade && hubPath !== "/api/devices/ws") ||
    (!readOnly && /\/api\/(stream-(mode|settings)|fold)$/.test(hubPath));
  const session = yield* authenticateMediaRequest(
    controlsDevice ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
  );
  const ended = yield* Lifetime.watch(session);
  const devices = yield* DeviceService.DeviceService;
  const ready = yield* devices.currentReadiness(url.value.searchParams.get("hostId") ?? undefined);
  if (!ready) {
    return HttpServerResponse.text("Device hub is not running", { status: 503 });
  }
  // Consume the auth ticket here; never forward it to the hub.
  const upstreamSearch = new URLSearchParams(url.value.search);
  upstreamSearch.delete("wsTicket");
  upstreamSearch.delete("hostId");
  const search = upstreamSearch.size > 0 ? `?${upstreamSearch.toString()}` : "";
  // Hosts with several upstreams (one per cloud session) route and authenticate requests themselves.
  const routed = ready.upstream ? yield* ready.upstream(hubPath, upstreamSearch) : undefined;
  if (routed === null) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const upstreamUrl = routed?.url ?? `${ready.hub.origin}${hubPath}${search}`;
  if (upgrade) {
    return yield* Lifetime.guard(
      session,
      proxyWebSocket(request, upstreamUrl.replace(/^http/, "ws"), routed?.protocols),
    );
  }
  const signal = WEBRTC_SIGNAL.exec(hubPath);
  if (signal === null) {
    return yield* proxyHttp(request, upstreamUrl, { extraHeaders: routed?.headers, stop: ended });
  }
  const read = yield* readSignal(request).pipe(Effect.result);
  if (Result.isFailure(read)) {
    return HttpServerResponse.text("Payload Too Large", { status: 413 });
  }
  const body = read.success;
  const owner = session.sessionId;
  const offer = signal[1] === "offer" && request.method === "POST";
  const httpClient = yield* HttpClient.HttpClient;
  const peer = WebRtcPeers.signalSessionId(body);
  // A peer belongs to one upstream helper; the client picks its id.
  const key = Option.map(peer, (id) =>
    [owner, upstreamUrl.replace(/\/(offer|close)(\?.*)?$/, ""), id].join("\u0000"),
  );
  const exchange = Effect.gen(function* () {
    if (offer && !(yield* peers.reserve(owner))) {
      return HttpServerResponse.text("Too Many Requests", { status: 429 });
    }
    const response = yield* proxyHttp(request, upstreamUrl, {
      extraHeaders: routed?.headers,
      body,
      stop: ended,
    }).pipe(Effect.onError(() => (offer ? peers.release(owner) : Effect.void)));
    const accepted = request.method === "POST" && response.status < 300;
    yield* Effect.uninterruptible(
      !accepted || Option.isNone(key) || Option.isNone(peer)
        ? offer
          ? peers.release(owner)
          : Effect.void
        : offer
          ? peers.opened(
              owner,
              key.value,
              ended,
              closeWebRtc(httpClient, upstreamUrl, routed?.headers, peer.value),
            )
          : peers.closed(key.value),
    );
    return response;
  });
  // Signals for one peer run one at a time, so a late close cannot cancel a newer offer's watch.
  return yield* Option.isSome(key) ? peers.serialize(key.value, exchange) : exchange;
});

export const layer = Layer.unwrap(
  Effect.map(Effect.scope, (scope) =>
    HttpRouter.add(
      "*",
      `${DeviceService.DEVICE_HUB_ROUTE_PREFIX}/*`,
      makeHandler(WebRtcPeers.make(scope)),
    ),
  ),
);
