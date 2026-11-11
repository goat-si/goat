// @effect-diagnostics nodeBuiltinImport:off - A network fixture: a loopback HTTP server records the upgrade.
import * as NodeHttp from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { WebSocketServer, type WebSocket } from "ws";
import { dialRelay, RELAY_LIMITS } from "./relayClient.ts";
import { ManualClock } from "./testing/manualClock.ts";
import { wsRelaySocketFactory } from "./testing/wsRelaySocket.ts";

const NODE = "cc5gqlek2e2rhfy6rnliqgvlrm";

/** A loopback relay stand-in that records each upgrade request and the close code each socket received. */
async function relayStandIn() {
  const server = NodeHttp.createServer();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const upgrades: Array<NodeHttp.IncomingHttpHeaders> = [];
  const connections: Array<{ socket: WebSocket; closeCode: Promise<number> }> = [];
  const waiters: Array<() => void> = [];
  server.on("upgrade", (request, socket, head) => {
    upgrades.push(request.headers);
    wss.handleUpgrade(request, socket, head, (ws) => {
      const closeCode = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
      connections.push({ socket: ws, closeCode });
      for (const wake of waiters.splice(0)) wake();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    origin: "ws://127.0.0.1:" + port,
    upgrades,
    connection: (n: number) =>
      new Promise<{ socket: WebSocket; closeCode: Promise<number> }>((resolve) => {
        const check = () => {
          const found = connections[n - 1];
          if (found !== undefined) resolve(found);
          else waiters.push(check);
        };
        check();
      }),
    [Symbol.asyncDispose]: async () => {
      for (const { socket } of connections) socket.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("the Node relay socket factory meets the factory contract (network fixture)", () => {
  it("a refused connection fails the dial 1006 and its error event does not escape", async () => {
    const server = NodeHttp.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const dial = dialRelay({
      relay: "ws://127.0.0.1:" + port,
      nodeId: NODE,
      factory: wsRelaySocketFactory,
      clock: new ManualClock(),
    });
    await expect(dial.opened).rejects.toMatchObject({ code: "relay-closed", closeCode: 1006 });
  });

  it("offers no WebSocket extension even to a server that would accept permessage-deflate", async () => {
    await using relay = await relayStandIn();
    const dial = dialRelay({
      relay: relay.origin,
      nodeId: NODE,
      factory: wsRelaySocketFactory,
      clock: new ManualClock(),
    });
    const link = await dial.opened;
    expect(relay.upgrades[0]?.["sec-websocket-extensions"]).toBeUndefined();
    expect(relay.upgrades[0]?.["sec-websocket-protocol"]).toBeUndefined();
    link.close(1000);
    expect(await (await relay.connection(1)).closeCode).toBe(1000);
  });

  it("puts the contract's close codes on the wire: 1003 for other text, 1009 for an oversized message, and 4400 and 4408", async () => {
    await using relay = await relayStandIn();
    const clock = new ManualClock();
    const open = async () =>
      await dialRelay({ relay: relay.origin, nodeId: NODE, factory: wsRelaySocketFactory, clock })
        .opened;

    await open();
    const first = await relay.connection(1);
    first.socket.send("hello");
    expect(await first.closeCode).toBe(1003);

    const second = await open();
    second.attach(() => undefined);
    const secondServer = await relay.connection(2);
    secondServer.socket.send(new Uint8Array(RELAY_LIMITS.message + 1));
    expect(await secondServer.closeCode).toBe(1009);

    (await open()).close(4400);
    expect(await (await relay.connection(3)).closeCode).toBe(4400);
    (await open()).close(4408);
    expect(await (await relay.connection(4)).closeCode).toBe(4408);
  });
});
