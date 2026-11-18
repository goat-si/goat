// @effect-diagnostics nodeBuiltinImport:off -- Real loopback HTTP against the gateway under test.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { HUB_PROXY_NODE_SCOPE_CEILING } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makePenGateway } from "./PenGateway.ts";
import { fakeChild, pin } from "./penGateway.testkit.ts";

const sessionAnswer = () => {
  const body = JSON.stringify({
    kind: "proxy",
    token: "secret",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scopes: HUB_PROXY_NODE_SCOPE_CEILING,
  });
  return `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
};
/** Sends requests to a route and resolves once `refusals` of them were answered. */
const sendUntilRefused = (url: string, count: number, refusals: number) => {
  const agent = new NodeHttp.Agent({ keepAlive: false, maxSockets: Infinity });
  const statuses: Array<number> = [];
  const refused = new Promise<Array<number>>((resolve) => {
    for (let index = 0; index < count; index++) {
      const req = NodeHttp.request(`${url}/api/projects`, {
        agent,
        headers: { origin: "goat://app" },
      });
      req.on("response", (res) => {
        statuses.push(res.statusCode ?? 0);
        res.resume();
        if (statuses.length === refusals) resolve(statuses);
      });
      req.on("error", () => {});
      req.end();
    }
  });
  return { refused, agent };
};

describe("Pen gateway session mint", () => {
  it("answers requests past the waiting limit at once while a mint is stalled", async () => {
    let mints = 0;
    let mintEnded = false;
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      // The member never answers the mint, so every private request waits for it.
      spawn: () => {
        const child = fakeChild((request) => {
          if (request.startsWith("POST /api/pen/session")) mints++;
        });
        child.once("exit", () => {
          mintEnded = true;
        });
        return child;
      },
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const agent = new NodeHttp.Agent({ keepAlive: false, maxSockets: Infinity });
      const statuses: Array<number> = [];
      const refused = new Promise<void>((resolve) => {
        for (let index = 0; index < 40; index++) {
          const req = NodeHttp.request(`${route.httpBaseUrl}/api/projects`, {
            agent,
            headers: { origin: "goat://app" },
          });
          req.on("response", (res) => {
            statuses.push(res.statusCode ?? 0);
            res.resume();
            if (statuses.length === 40 - 32) resolve();
          });
          req.on("error", () => {});
          req.end();
        }
      });
      await refused;
      expect(statuses).toEqual(Array.from({ length: 8 }, () => 503));
      // Refused by the limit, not by the mint giving up: the one mint is still waiting.
      expect([mints, mintEnded]).toEqual([1, false]);
      agent.destroy();
    } finally {
      await gateway.dispose();
    }
  });

  it("refuses a fifth request one socket sends while its first four wait for the mint", async () => {
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () =>
        fakeChild((request, stdout) =>
          stdout.end(
            request.startsWith("POST /api/pen/session")
              ? sessionAnswer()
              : "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
          ),
        ),
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const url = new URL(route.httpBaseUrl);
      const request = `GET ${url.pathname}/api/projects HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: goat://app\r\n\r\n`;
      // One write: the gateway reads all five before the mint can answer any of them.
      const answer = await new Promise<string>((resolve, reject) => {
        let received = "";
        const socket = NodeNet.connect(Number(url.port), "127.0.0.1", () =>
          socket.write(request.repeat(5)),
        );
        socket.on("data", (bytes: Buffer) => {
          received += bytes.toString();
          if ((received.match(/HTTP\/1\.1 \d+/g) ?? []).length === 5) {
            socket.destroy();
            resolve(received);
          }
        });
        socket.on("error", reject);
      });
      expect(answer.match(/HTTP\/1\.1 (\d+)/g)).toEqual([
        "HTTP/1.1 200",
        "HTTP/1.1 200",
        "HTTP/1.1 200",
        "HTTP/1.1 200",
        "HTTP/1.1 503",
      ]);
    } finally {
      await gateway.dispose();
    }
  });

  it("answers a request it cannot parse without letting it be cached", async () => {
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () => fakeChild(),
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
          socket.write("NOT HTTP\r\n\r\n"),
        );
        socket.on("data", (bytes: Buffer) => (received += bytes.toString()));
        socket.on("error", reject);
        socket.on("close", () => resolve(received));
      });
      expect(answer.startsWith("HTTP/1.1 400 ")).toBe(true);
      expect(answer.toLowerCase()).toContain("cache-control: no-store");
      // An upgrade that is no WebSocket GET is refused with the same headers.
      const refused = await new Promise<string>((resolve, reject) => {
        let received = "";
        const socket = NodeNet.connect(Number(url.port), "127.0.0.1", () =>
          socket.write(
            `OPTIONS ${url.pathname}/ws HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: goat://app\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
          ),
        );
        socket.on("data", (bytes: Buffer) => (received += bytes.toString()));
        socket.on("error", reject);
        socket.on("close", () => resolve(received));
      });
      expect(refused.startsWith("HTTP/1.1 400 ")).toBe(true);
      expect(refused.toLowerCase()).toContain("cache-control: no-store");
      expect(refused.toLowerCase()).toContain("referrer-policy: no-referrer");
      // Node answers an Expect it does not support by itself, unless the gateway does.
      const expectation = await new Promise<string>((resolve, reject) => {
        let received = "";
        const socket = NodeNet.connect(Number(url.port), "127.0.0.1", () =>
          socket.write(
            `GET ${url.pathname}/api/projects HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: goat://app\r\nExpect: something\r\nConnection: close\r\n\r\n`,
          ),
        );
        socket.on("data", (bytes: Buffer) => (received += bytes.toString()));
        socket.on("error", reject);
        socket.on("close", () => resolve(received));
      });
      expect(expectation.startsWith("HTTP/1.1 417 ")).toBe(true);
      expect(expectation.toLowerCase()).toContain("cache-control: no-store");
      expect(expectation.toLowerCase()).toContain("referrer-policy: no-referrer");
    } finally {
      await gateway.dispose();
    }
  });

  it("answers an upgrade past the waiting limit with 503, as an ordinary request", async () => {
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      // The member never answers the mint.
      spawn: () => fakeChild(),
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const full = sendUntilRefused(route.httpBaseUrl, 33, 1);
      expect(await full.refused).toEqual([503]);
      const url = new URL(route.httpBaseUrl);
      const answer = await new Promise<string>((resolve, reject) => {
        let received = "";
        const socket = NodeNet.connect(Number(url.port), "127.0.0.1", () =>
          socket.write(
            `GET ${url.pathname}/ws HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: goat://app\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
          ),
        );
        socket.on("data", (bytes: Buffer) => (received += bytes.toString()));
        socket.on("error", reject);
        socket.on("close", () => resolve(received));
      });
      expect(answer.startsWith("HTTP/1.1 503 ")).toBe(true);
      full.agent.destroy();
    } finally {
      await gateway.dispose();
    }
  });

  it("refuses at once a route's request once every route together holds 256 waiting", async () => {
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      // No member answers its mint.
      spawn: (_binary, args) =>
        fakeChild(undefined, true, { ...pin, nodeId: args[2] ?? "", noisePub: args[4] ?? "" }),
      randomBytes: (() => {
        let next = 0;
        return (size: number) => Buffer.alloc(size, ++next);
      })(),
      appOrigins: ["goat://app"],
    });
    try {
      const routes = [];
      for (const letter of "bcdefghij") {
        const route = await gateway.open({
          ...pin,
          nodeId: letter.repeat(26),
          noisePub: letter.repeat(43),
        });
        if (route.kind !== "open") throw new Error("route refused");
        routes.push(route.httpBaseUrl);
      }
      // The listener takes 256 sockets, so only pipelined requests reach 256 waiting: eight
      // routes at their limit of 32, four on each socket. All are written before the last one.
      const held: Array<NodeNet.Socket> = [];
      await Promise.all(
        routes.slice(0, 8).flatMap((base) => {
          const url = new URL(base);
          const request = `GET ${url.pathname}/api/projects HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: goat://app\r\n\r\n`;
          return Array.from(
            { length: 8 },
            () =>
              new Promise<void>((resolve, reject) => {
                const socket = NodeNet.connect(Number(url.port), "127.0.0.1", () =>
                  socket.write(request.repeat(4), () => resolve()),
                );
                socket.on("error", reject);
                held.push(socket);
              }),
          );
        }),
      );
      const last = sendUntilRefused(routes[8] ?? "", 1, 1);
      expect(await last.refused).toEqual([503]);
      last.agent.destroy();
      for (const socket of held) socket.destroy();
    } finally {
      await gateway.dispose();
    }
  });
});
