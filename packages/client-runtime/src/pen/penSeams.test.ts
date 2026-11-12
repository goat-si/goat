// The Pen client's adapters behind the real seams: layerRemoteHttpClient (HttpClient over a fetch function) and
// effect's WebSocket socket (Socket.WebSocketConstructor), over the whole Pen path to a loopback server: relay socket,
// handshake race, Noise session, stream framing, then HTTP/1.1 or RFC 6455. Test only: no runtime code here uses Pen.
import { describe, expect, it } from "@effect/vitest";
import { generateX25519 } from "@goat/pen-protocol/client/crypto";
import { Kind } from "@goat/pen-protocol/client/noise";
import { makePenFetch } from "@goat/pen-protocol/client/pen-fetch";
import { makePenWebSocketConstructor } from "@goat/pen-protocol/client/pen-websocket";
import { openSession } from "@goat/pen-protocol/client/race";
import type { Clock } from "@goat/pen-protocol/client/runtime";
import { openStream } from "@goat/pen-protocol/client/stream";
import { startLoopbackNode, startTargetServer } from "@goat/pen-protocol/testing/loopback-node";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { layerRemoteHttpClient } from "../rpc/http.ts";

const NODE_ID = "cc5gqlek2e2rhfy6rnliqgvlrm";
const ORIGIN = "http://goat.pen";
// Deadlines are proven in pen-protocol with a manual clock; here timers never fire.
const clock: Clock = { now: () => 0, setTimer: () => ({ cancel: () => undefined }) };
let seed = 1;
const random = (n: number) =>
  Uint8Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255);

async function penPath() {
  const target = await startTargetServer();
  const serverKey = generateX25519(random);
  const node = startLoopbackNode({
    nodeId: NODE_ID,
    key: serverKey,
    target: { host: "127.0.0.1", port: target.port },
    random,
  });
  const phone = generateX25519(random);
  const open = async () => {
    const { session } = await openSession({
      relays: ["ws://127.0.0.1:9"],
      nodeId: NODE_ID,
      serverNoisePub: serverKey.publicKey,
      kind: Kind.Session,
      payload: { v: 1, stream: "service", name: "goat" },
      localStatic: phone,
      factory: node.factory,
      clock,
      random,
    });
    return openStream(session);
  };
  return {
    node,
    fetch: makePenFetch({ origin: ORIGIN, openStream: open, clock }),
    webSocket: makePenWebSocketConstructor({ origin: ORIGIN, openStream: open, clock, random }),
    [Symbol.asyncDispose]: async () => {
      node.close();
      await target.close();
    },
  };
}

const penPathScoped = Effect.acquireRelease(
  Effect.promise(() => penPath()),
  (pen) => Effect.promise(() => pen[Symbol.asyncDispose]()),
);

describe("Pen adapters behind client-runtime's seams (design 10.1, spike S7 on Node)", () => {
  // it.live: these run real loopback sockets end to end.
  it.live(
    "layerRemoteHttpClient over Pen: JSON GET and POST, 204, 304, an 8 MiB chunked body, and refusals",
    () =>
      Effect.gen(function* () {
        const pen = yield* penPathScoped;
        yield* Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const json = yield* client.get(ORIGIN + "/json");
          expect(json.status).toBe(200);
          expect(yield* json.json).toEqual({ ok: true });
          const echo = yield* client.post(ORIGIN + "/echo", {
            body: {
              _tag: "Uint8Array",
              body: new TextEncoder().encode('{"a":1}'),
              contentType: "application/json",
              contentLength: 7,
            } as never,
          });
          expect(yield* echo.json).toEqual({ a: 1 });
          expect((yield* client.get(ORIGIN + "/empty")).status).toBe(204);
          expect((yield* client.get(ORIGIN + "/not-modified")).status).toBe(304);
          const big = yield* client.get(ORIGIN + "/big");
          expect((yield* big.arrayBuffer).byteLength).toBe(8 * 1024 * 1024);
          // The server sends the over-cap body chunked, so the running chunk total refuses it.
          const tooBig = yield* Effect.flip(client.get(ORIGIN + "/too-big"));
          expect(tooBig.reason).toMatchObject({ cause: { code: "http1/H26" } });
          const otherOrigin = yield* Effect.flip(client.get("http://other.pen/json"));
          expect(otherOrigin.reason).toMatchObject({ cause: { code: "http1/H47" } });
        }).pipe(Effect.provide(layerRemoteHttpClient(pen.fetch)));
        // Requests reuse a stream after clean responses; a refused response closes its stream.
        expect(pen.node.sessions()).toBeLessThanOrEqual(3);
      }).pipe(Effect.scoped),
  );

  it.live(
    "Socket.makeWebSocket over Pen: echoes text and binary, and reports the server's close code",
    () =>
      Effect.gen(function* () {
        const pen = yield* penPathScoped;
        const { received, closed } = yield* Effect.gen(function* () {
          const socket = yield* Socket.makeWebSocket("ws://goat.pen/ws");
          const { write } = yield* socket.writer;
          const { pull } = yield* socket.reader;
          yield* write("hello");
          yield* write(new Uint8Array(70_000).fill(7));
          const received: Array<string | Uint8Array> = [];
          while (received.length < 2) received.push(...(yield* pull));
          yield* write("close-4000");
          const closed = yield* Effect.flip(Effect.forever(pull));
          return { received, closed };
        }).pipe(Effect.provideService(Socket.WebSocketConstructor, pen.webSocket as never));
        expect(received[0]).toBe("hello");
        expect((received[1] as Uint8Array).length).toBe(70_000);
        expect(closed.reason).toMatchObject({ _tag: "SocketCloseError", code: 4000 });
      }).pipe(Effect.scoped),
  );
});
