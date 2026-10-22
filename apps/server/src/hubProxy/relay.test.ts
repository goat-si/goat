import * as NodeEvents from "node:events";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Socket from "effect/socket/Socket";

import {
  RELAY_MAX_BUFFERED_BYTES,
  RelayOverflowError,
  type RelayWebSocket,
  pumpFrames,
  pumpGated,
  relay,
  relaySink,
  webSocketOfTransport,
} from "./relay.ts";

const byteLength = (frame: string | Uint8Array) =>
  typeof frame === "string" ? new TextEncoder().encode(frame).byteLength : frame.byteLength;

/**
 * A ws socket whose peer stopped reading: sends stay queued (as in ws's compression queue or TCP
 * buffer), counted in bufferedAmount, and their callbacks run only when `flush` is called.
 */
const stalledWebSocket = () => {
  const events = new NodeEvents.EventEmitter();
  const queued: Array<{ readonly bytes: number; readonly done: (error?: Error) => void }> = [];
  const frames: Array<string | Uint8Array> = [];
  let readyState = 1;
  events.once("close", () => {
    readyState = 3;
  });
  const ws: RelayWebSocket = {
    get readyState() {
      return readyState;
    },
    get bufferedAmount() {
      return queued.reduce((total, entry) => total + entry.bytes, 0);
    },
    send: (data, callback) => {
      frames.push(data);
      queued.push({ bytes: byteLength(data), done: callback });
    },
    once: (event, listener) => events.once(event, listener),
    off: (event, listener) => events.off(event, listener),
  };
  return {
    ws,
    frames,
    events,
    flush: () => {
      for (const entry of queued.splice(0)) entry.done();
    },
  };
};

const source = (pulls: number, batch: () => ReadonlyArray<string>) => {
  let pulled = 0;
  const reader: Socket.Reader = {
    pull: Effect.suspend(() => {
      if (pulled >= pulls) return Effect.never;
      pulled += 1;
      return Effect.succeed(batch() as unknown as readonly [string, ...string[]]);
    }),
    upgrade: () => Effect.void,
  };
  return { reader, pulled: () => pulled };
};

const refusedBatch = (size: number) => {
  let id = 0;
  return () =>
    Array.from({ length: size }, () =>
      JSON.stringify({
        _tag: "Request",
        id: String((id += 1)),
        tag: "orchestration.dispatchCommand",
        payload: { type: "thread.delete", commandId: `c${id}`, threadId: "t1" },
        headers: [],
      }),
    );
};

const operate = ["orchestration:read", "orchestration:operate"] as const;

it.effect("a stalled client stops the node-to-client relay after one batch", () =>
  Effect.gen(function* () {
    const client = stalledWebSocket();
    const node = source(128, () => ["x".repeat(64 * 1024)]);
    const pump = yield* Effect.forkChild(pumpFrames(node.reader, relaySink(client.ws)));
    yield* Effect.yieldNow;
    // Nothing more is pulled while the frame sits in ws's queue, even with TCP empty.
    expect(node.pulled()).toBe(1);
    client.flush();
    yield* Effect.yieldNow;
    expect(node.pulled()).toBe(2);
    yield* Fiber.interrupt(pump);
  }),
);

it.effect("a client that sends refused calls but never reads stops being read", () =>
  Effect.gen(function* () {
    const client = stalledWebSocket();
    const node = stalledWebSocket();
    const phone = source(128, refusedBatch(500));
    const pump = yield* Effect.forkChild(
      pumpGated(phone.reader, relaySink(node.ws), relaySink(client.ws), operate),
    );
    yield* Effect.yieldNow;
    expect(phone.pulled()).toBe(1);
    expect(client.frames).toHaveLength(500);
    expect(node.frames).toEqual([]);
    client.flush();
    yield* Effect.yieldNow;
    expect(phone.pulled()).toBe(2);
    yield* Fiber.interrupt(pump);
  }),
);

it.effect("a relay ends once a batch leaves more than the cap queued in ws", () =>
  Effect.gen(function* () {
    const client = stalledWebSocket();
    const oversized = "x".repeat(RELAY_MAX_BUFFERED_BYTES + 1);
    const forwarded = yield* Effect.flip(
      pumpFrames(source(1, () => [oversized]).reader, relaySink(client.ws)),
    );
    expect(forwarded).toBeInstanceOf(RelayOverflowError);
    // Refusals echo the request id, so one refused call can carry a reply past the cap.
    const hugeRefusal = JSON.stringify({
      _tag: "Request",
      id: "x".repeat(RELAY_MAX_BUFFERED_BYTES + 1),
      tag: "orchestration.dispatchCommand",
      payload: { type: "thread.delete", commandId: "c1", threadId: "t1" },
      headers: [],
    });
    const refused = yield* Effect.flip(
      pumpGated(
        source(1, () => [hugeRefusal]).reader,
        relaySink(stalledWebSocket().ws),
        relaySink(stalledWebSocket().ws),
        operate,
      ),
    );
    expect(refused).toBeInstanceOf(RelayOverflowError);
  }),
);

it.effect(
  "a socket that closes releases a waiting relay, and an interrupted wait leaves nothing behind",
  () =>
    Effect.gen(function* () {
      const closing = stalledWebSocket();
      const sink = relaySink(closing.ws);
      yield* sink.write("frame");
      const waiting = yield* Effect.forkChild(sink.sent);
      yield* Effect.yieldNow;
      closing.events.emit("close");
      yield* Fiber.join(waiting);
      expect(yield* Effect.flip(sink.write("after close"))).toMatchObject({
        name: "RelaySendError",
      });

      const stalled = stalledWebSocket();
      const other = relaySink(stalled.ws);
      yield* other.write("frame");
      const interrupted = yield* Effect.forkChild(other.sent);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(interrupted);
      // Completing the send afterwards must not resume the interrupted wait.
      stalled.flush();
      yield* other.sent;
    }),
);

it("finds the ws that took over an upgraded socket, and nothing on a plain one", () => {
  const ws = stalledWebSocket().ws;
  const upgraded = { [Symbol("websocket")]: ws };
  expect(webSocketOfTransport(upgraded)).toBe(ws);
  expect(webSocketOfTransport({})).toBeUndefined();
  expect(webSocketOfTransport(undefined)).toBeUndefined();
});

const idle: Socket.Reader = { pull: Effect.never, upgrade: () => Effect.void };

it.effect("a relay ends when the node closes while the phone has stopped reading", () =>
  Effect.gen(function* () {
    const client = stalledWebSocket();
    const node = stalledWebSocket();
    const running = yield* Effect.forkChild(
      relay({
        upstreamReader: source(1, () => ["event"]).reader,
        upstream: relaySink(node.ws),
        clientReader: idle,
        client: relaySink(client.ws),
        scopes: operate,
        stop: [],
      }),
    );
    yield* Effect.yieldNow;
    // The forwarded event is still queued for the stalled phone; only the node closes.
    expect(client.frames).toEqual(["event"]);
    node.events.emit("close");
    yield* Fiber.join(running);
  }),
);

it.effect("a relay ends when the node closes while a refusal waits for the phone", () =>
  Effect.gen(function* () {
    const client = stalledWebSocket();
    const node = stalledWebSocket();
    const running = yield* Effect.forkChild(
      relay({
        upstreamReader: idle,
        upstream: relaySink(node.ws),
        clientReader: source(2, refusedBatch(1)).reader,
        client: relaySink(client.ws),
        scopes: operate,
        stop: [],
      }),
    );
    yield* Effect.yieldNow;
    expect(client.frames).toHaveLength(1);
    node.events.emit("close");
    yield* Fiber.join(running);
  }),
);

it.effect("a socket that had already closed counts as closed", () =>
  Effect.gen(function* () {
    const gone = stalledWebSocket();
    gone.events.emit("close");
    yield* relaySink(gone.ws).closed;
  }),
);
