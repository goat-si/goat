import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import { vi } from "vite-plus/test";

const native = vi.hoisted(() => {
  type Listener = (payload: Record<string, unknown>) => void;
  // The wrapper attaches one native listener per event for the app's lifetime, so setup() keeps them.
  const listeners = new Map<string, Listener>();
  const calls: Array<{ readonly method: string; readonly args: ReadonlyArray<unknown> }> = [];
  let onConnect: ((id: number) => void) | undefined;
  const record =
    (method: string) =>
    (...args: ReadonlyArray<unknown>) => {
      calls.push({ method, args });
    };
  return {
    calls,
    setup: () => {
      calls.length = 0;
      onConnect = undefined;
    },
    emit: (event: string, payload: Record<string, unknown>) => listeners.get(event)?.(payload),
    lastId: () => calls.findLast((call) => call.method === "connect")?.args[0] as number,
    whenConnected: (script: (id: number) => void) => {
      onConnect = script;
    },
    module: {
      connect: (...args: ReadonlyArray<unknown>) => {
        calls.push({ method: "connect", args });
        onConnect?.(args[0] as number);
      },
      sendText: record("sendText"),
      sendBinary: record("sendBinary"),
      close: record("close"),
      addListener: (event: string, listener: Listener) => {
        listeners.set(event, listener);
        return { remove: () => listeners.delete(event) };
      },
    },
  };
});

vi.mock("expo", () => ({ requireOptionalNativeModule: () => native.module }));

import { layerWebSocketConstructor } from "./webSocketConstructor.ios";

const testEffect = <A, E>(effect: Effect.Effect<A, E, Socket.WebSocketConstructor>) =>
  effect.pipe(Effect.provide(layerWebSocketConstructor));

describe("iOS URLSession WebSocket constructor", () => {
  it.effect("carries an Effect socket from open through messages to the server's close code", () =>
    testEffect(
      Effect.gen(function* () {
        native.setup();
        // Native events arrive after the constructor returns, as they do from URLSession.
        native.whenConnected((id) =>
          queueMicrotask(() => {
            native.emit("onOpen", { id });
            native.emit("onMessage", { id, data: "hello", binary: false });
            native.emit("onMessage", { id, data: btoa("\x01\x02\xff"), binary: true });
            native.emit("onClose", { id, code: 4001, reason: "server-close" });
          }),
        );
        const socket = yield* Socket.makeWebSocket("wss://host.test/hub/nodes/n1/ws");
        const received: Array<string | Uint8Array> = [];
        const error = yield* Effect.gen(function* () {
          const { pull } = yield* socket.reader;
          while (true) received.push(...(yield* pull));
        }).pipe(Effect.scoped, Effect.flip);

        expect(native.calls.find((call) => call.method === "connect")?.args.slice(1)).toEqual([
          "wss://host.test/hub/nodes/n1/ws",
          [],
        ]);
        expect(received[0]).toBe("hello");
        expect([...(received[1] as Uint8Array)]).toEqual([1, 2, 255]);
        expect(error.reason).toMatchObject({ _tag: "SocketCloseError", code: 4001 });
      }),
    ),
  );

  it.effect("routes native events by connection and reports each close once", () =>
    testEffect(
      Effect.gen(function* () {
        native.setup();
        const construct = yield* Socket.WebSocketConstructor;
        const first = construct("wss://host.test/ws");
        const firstId = native.lastId();
        const second = construct("wss://host.test/ws");
        const closed = vi.fn();
        first.addEventListener("close", closed);
        second.addEventListener("close", closed);

        native.emit("onClose", { id: firstId, code: 1006, reason: "lost" });
        native.emit("onClose", { id: firstId, code: 1006, reason: "lost" });

        expect(closed).toHaveBeenCalledTimes(1);
        expect(first.readyState).toBe(3);
        expect(second.readyState).toBe(0);
      }),
    ),
  );

  it.effect(
    "a caller's close ends in one close event and drops the connection's later events",
    () =>
      testEffect(
        Effect.gen(function* () {
          native.setup();
          const socket = (yield* Socket.WebSocketConstructor)("wss://host.test/ws");
          const id = native.lastId();
          const closed = vi.fn();
          const messages = vi.fn();
          socket.addEventListener("close", closed);
          socket.addEventListener("message", messages);
          native.emit("onOpen", { id });

          socket.close(1000, "reconnect");
          expect(socket.readyState).toBe(2);
          // The native module reports a client close from URLSession's clean completion.
          native.emit("onClose", { id, code: 1000, reason: "reconnect" });
          native.emit("onClose", { id, code: 1000, reason: "reconnect" });
          native.emit("onMessage", { id, data: "late", binary: false });

          expect(socket.readyState).toBe(3);
          expect(closed).toHaveBeenCalledTimes(1);
          expect(closed).toHaveBeenCalledWith({ type: "close", code: 1000, reason: "reconnect" });
          expect(messages).not.toHaveBeenCalled();
        }),
      ),
  );

  it.effect("ignores a native open that lands after the caller closed a connecting socket", () =>
    testEffect(
      Effect.gen(function* () {
        native.setup();
        const socket = (yield* Socket.WebSocketConstructor)("wss://host.test/ws");
        const id = native.lastId();
        const opened = vi.fn();
        socket.addEventListener("open", opened);

        socket.close(1000, "timeout");
        socket.close(1000, "timeout");
        native.emit("onOpen", { id });

        expect(opened).not.toHaveBeenCalled();
        expect(socket.readyState).toBe(2);
        expect(native.calls.filter((call) => call.method === "close")).toEqual([
          { method: "close", args: [id, 1000, "timeout"] },
        ]);
      }),
    ),
  );

  it.effect("refuses to send while connecting and sends binary as base64 once open", () =>
    testEffect(
      Effect.gen(function* () {
        native.setup();
        const socket = (yield* Socket.WebSocketConstructor)("wss://host.test/ws");
        const id = native.lastId();

        expect(() => socket.send("early")).toThrow("INVALID_STATE_ERR");
        native.emit("onOpen", { id });
        socket.send(new Uint8Array([1, 2, 255]));

        expect(native.calls.filter((call) => call.method.startsWith("send"))).toEqual([
          { method: "sendBinary", args: [id, btoa("\x01\x02\xff")] },
        ]);
      }),
    ),
  );
});
