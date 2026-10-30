import {
  ServerConfig,
  ServerConfigStreamEvent,
  type ServerConfigStreamEvent as ServerConfigStreamEventType,
  WS_METHODS,
} from "@goat/contracts";
import { expect } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

import * as RpcSession from "./session.ts";
import { SERVER_CONFIG } from "./sessionTestFixtures.ts";

/** A scripted websocket for RpcSession tests: the test plays the server. */
export type SocketEventType = "open" | "message" | "close" | "error";
export type SocketEvent = {
  readonly code?: number;
  readonly data?: unknown;
  readonly reason?: string;
  readonly type: SocketEventType;
};
export type SocketListener = (event: SocketEvent) => void;

export class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = TestWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly requests = new Map<number, Deferred.Deferred<typeof RpcRequest.Type>>();
  readonly url: string;
  readonly sentChanges: Queue.Queue<void>;
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  constructor(url: string, sentChanges: Queue.Queue<void>) {
    this.url = url;
    this.sentChanges = sentChanges;
  }

  addEventListener(type: SocketEventType, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEventType, listener: SocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
    Queue.offerUnsafe(this.sentChanges, undefined);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === TestWebSocket.CLOSED) {
      return;
    }
    this.readyState = TestWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: string) {
    this.emit("message", { data, type: "message" });
  }

  private emit(type: SocketEventType, event: SocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

export const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.Union([Schema.String, Schema.Number]),
  payload: Schema.Unknown,
  tag: Schema.String,
});
export const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
export const isRpcRequest = Schema.is(RpcRequest);
export const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
export const encodeServerConfig = Schema.encodeSync(ServerConfig);
const encodeServerConfigStreamEvent = Schema.encodeSync(ServerConfigStreamEvent);
export const encodeDefect = Schema.encodeSync(Schema.Defect());
export const ENCODED_SERVER_CONFIG = encodeServerConfig(SERVER_CONFIG);

export const makeFactory = Effect.fn("TestRpcSessionFactory.make")(function* (
  options: RpcSession.RpcSessionOptions = {},
) {
  const sentChanges = yield* Queue.unbounded<void>();
  const sockets = Object.assign([] as TestWebSocket[], { changes: yield* Queue.unbounded<void>() });
  const layerConstructor = Layer.succeed(Socket.WebSocketConstructor, (url) => {
    const socket = new TestWebSocket(url, sentChanges);
    sockets.push(socket);
    Queue.offerUnsafe(sockets.changes, undefined);
    return socket as unknown as globalThis.WebSocket;
  });
  const layer = RpcSession.layer(options).pipe(Layer.provide(layerConstructor));
  const factory = yield* RpcSession.RpcSessionFactory.pipe(Effect.provide(layer));
  return { factory, sockets };
});

export const awaitSocket = Effect.fn("TestRpcSessionFactory.awaitSocket")(function* (
  sockets: ReadonlyArray<TestWebSocket> & { readonly changes: Queue.Queue<void> },
  index = 0,
) {
  for (;;) {
    const socket = sockets[index];
    if (socket) {
      return socket;
    }
    yield* Queue.take(sockets.changes);
  }
});

export const awaitRequest = Effect.fn("TestRpcSessionFactory.awaitRequest")(function* (
  socket: TestWebSocket,
  index = 0,
) {
  for (;;) {
    const request = socket.sent.map((message) => decodeJson(message)).filter(isRpcRequest)[index];
    if (request) {
      return request;
    }
    yield* Queue.take(socket.sentChanges);
  }
});

export const completeInitialConfig = Effect.fn("TestRpcSessionFactory.completeInitialConfig")(
  function* (
    socket: TestWebSocket,
    config: unknown = ENCODED_SERVER_CONFIG,
    payload: unknown = {},
  ) {
    const request = yield* awaitRequest(socket);
    expect(request).toMatchObject({
      _tag: "Request",
      tag: WS_METHODS.subscribeServerConfig,
      payload,
    });
    socket.serverMessage(
      encodeJson({
        _tag: "Chunk",
        requestId: request.id,
        values: [{ version: 1, type: "snapshot", config }],
      }),
    );
  },
);

export const publishConfigEvents = Effect.fn("TestRpcSessionFactory.publishConfigEvents")(
  function* (socket: TestWebSocket, events: ReadonlyArray<ServerConfigStreamEventType>) {
    const request = yield* awaitRequest(socket);
    socket.serverMessage(
      encodeJson({
        _tag: "Chunk",
        requestId: request.id,
        values: events.map((event) => encodeServerConfigStreamEvent(event)),
      }),
    );
  },
);
