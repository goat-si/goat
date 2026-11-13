// @effect-diagnostics nodeBuiltinImport:off -- Exercises a local listener and fake Pen subprocess.
import * as NodeNet from "node:net";
import { describe, expect, it, vi } from "vite-plus/test";
import { HUB_PROXY_NODE_SCOPE_CEILING } from "@goat/contracts";
import { makePenGateway } from "./PenGateway.ts";
import { fakeChild, fetchUrl, pin } from "./penGateway.testkit.ts";

const sessionAnswer = () => {
  const body = JSON.stringify({
    kind: "proxy",
    token: "secret",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scopes: HUB_PROXY_NODE_SCOPE_CEILING,
  });
  return `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};
const upgradeRequest = (url: URL, extra = "") =>
  `GET ${url.pathname}/ws HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: goat://app\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n${extra}`;

describe("Pen gateway upgrades and mints that do not complete", () => {
  it("a refused upgrade is relayed and closed, and the client's bytes never reach the member", async () => {
    let frames = 0;
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () => {
        const child = fakeChild((request, stdout) => {
          if (request.startsWith("POST /api/pen/session")) return void stdout.end(sessionAnswer());
          child.stdin?.on("data", () => frames++);
          stdout.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        });
        return child;
      },
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const url = new URL(route.httpBaseUrl);
      const answer = await new Promise<string>((resolve, reject) => {
        let received = "";
        const socket = NodeNet.connect(Number(url.port), "127.0.0.1", () =>
          socket.write(upgradeRequest(url, "client-frame")),
        );
        socket.on("data", (bytes: Buffer) => (received += bytes.toString()));
        socket.on("error", reject);
        socket.on("close", () => resolve(received));
      });
      expect(answer.startsWith("HTTP/1.1 403 ")).toBe(true);
      expect(frames).toBe(0);
    } finally {
      await gateway.dispose();
    }
  });

  it("a client that leaves during an upgrade does not leave its child running", async () => {
    let requestSeen = () => {};
    const requestReady = new Promise<void>((resolve) => {
      requestSeen = resolve;
    });
    let childKilled = () => {};
    const killed = new Promise<void>((resolve) => {
      childKilled = resolve;
    });
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () => {
        const child = fakeChild((request, stdout) => {
          if (request.startsWith("POST /api/pen/session")) return void stdout.end(sessionAnswer());
          // The member never answers the upgrade.
          const kill = child.kill.bind(child);
          child.kill = (signal) => {
            childKilled();
            return kill(signal);
          };
          requestSeen();
        });
        return child;
      },
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const url = new URL(route.httpBaseUrl);
      const socket = NodeNet.connect(Number(url.port), "127.0.0.1", () =>
        socket.write(upgradeRequest(url)),
      );
      socket.on("error", () => {});
      await requestReady;
      socket.destroy();
      await killed;
    } finally {
      await gateway.dispose();
    }
  });

  it("requests waiting on a session mint that never completes are answered 503 at its deadline", async () => {
    let mintSeen = () => {};
    const mintReady = new Promise<void>((resolve) => {
      mintSeen = resolve;
    });
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      // The member reads the mint request and never answers it.
      spawn: () => fakeChild(() => mintSeen()),
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const answer = fetchUrl(`${route.httpBaseUrl}/api/projects`, { origin: "goat://app" });
      await mintReady;
      vi.advanceTimersByTime(30_000);
      expect((await answer).status).toBe(503);
    } finally {
      vi.useRealTimers();
      await gateway.dispose();
    }
  });
});
