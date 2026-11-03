import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";

const live = new Set<HeartbeatWebSocket>();
const connectingSeen = new WeakSet<HeartbeatWebSocket>();

export class HeartbeatWebSocket extends NodeWS.WebSocket {
  private terminating = false;
  private pingPending = false;

  constructor(address: null);
  constructor(address: string | URL, options?: NodeWS.WebSocket.ClientOptions);
  constructor(
    address: string | URL,
    protocols?: string | string[],
    options?: NodeWS.WebSocket.ClientOptions,
  );
  constructor(
    address: string | URL | null,
    protocols?: string | string[] | NodeWS.WebSocket.ClientOptions,
    options?: NodeWS.WebSocket.ClientOptions,
  ) {
    super(address as string, protocols as string | string[], options);
    this.on("error", () => this.terminateOnce());
    live.add(this);
    this.once("close", () => {
      live.delete(this);
      this.pingPending = false;
    });
  }

  // A peer that stops reading would otherwise grow the send buffer by one ping per tick.
  heartbeatPing() {
    if (this.pingPending) return;
    this.pingPending = true;
    this.ping(undefined, undefined, (error) => {
      this.pingPending = false;
      if (error) this.terminateOnce();
    });
  }

  terminateOnce() {
    if (this.terminating) return;
    this.terminating = true;
    this.terminate();
  }
}

export const heartbeat = Effect.sleep("30 seconds").pipe(
  Effect.andThen(
    Effect.sync(() => {
      for (const socket of live) {
        if (socket.readyState === NodeWS.WebSocket.OPEN) {
          socket.heartbeatPing();
        } else if (
          socket.readyState !== NodeWS.WebSocket.CONNECTING ||
          connectingSeen.has(socket)
        ) {
          live.delete(socket);
        } else {
          connectingSeen.add(socket);
        }
      }
    }),
  ),
  Effect.forever,
);
