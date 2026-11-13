// @effect-diagnostics nodeBuiltinImport:off -- Exercises a local listener and fake Pen subprocess.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import { HUB_PROXY_NODE_SCOPE_CEILING } from "@goat/contracts";
import { websocketAccept } from "@goat/pen-protocol/client/http1";
import { makePenGateway } from "./PenGateway.ts";
import { fakeChild, fetchUrl, pin } from "./penGateway.testkit.ts";

describe("Pen gateway", () => {
  it("fetches public descriptors without minting or sending a bearer", async () => {
    const requests: string[] = [];
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () =>
        fakeChild((request, stdout) => {
          requests.push(request);
          stdout.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        }),
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      expect(
        (
          await fetchUrl(`${route.httpBaseUrl}/.well-known/goat/environment`, {
            origin: "goat://app",
          })
        ).status,
      ).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toMatch(/authorization:/i);
    } finally {
      await gateway.dispose();
    }
  });
  it.each([
    ["refused", "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n", 403],
    [
      "bad accept",
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: wrong\r\n\r\n",
      502,
    ],
    [
      "redirect",
      "HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: https://example.com\r\n\r\n",
      502,
    ],
  ])("returns and closes a %s WebSocket handshake", async (_name, upstream, expected) => {
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () =>
        fakeChild((request, stdout) => {
          if (request.startsWith("POST /api/pen/session")) {
            const body = JSON.stringify({
              kind: "proxy",
              token: "secret",
              expiresAt: "2099-01-01T00:00:00.000Z",
              scopes: HUB_PROXY_NODE_SCOPE_CEILING,
            });
            stdout.end(
              `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
            );
          } else stdout.end(upstream);
        }),
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const status = await new Promise<number>((resolve, reject) => {
        const req = NodeHttp.request(`${route.httpBaseUrl}/ws`, {
          headers: {
            origin: "goat://app",
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
          },
        });
        req.on("response", (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("upgrade", () => reject(new Error("unexpected upgrade")));
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(expected);
    } finally {
      await gateway.dispose();
    }
  });
  it("caps children across all routes at 128", async () => {
    let blocking = false;
    let active = 0;
    let allStarted = () => {};
    let halfStarted = () => {};
    const started = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    const half = new Promise<void>((resolve) => {
      halfStarted = resolve;
    });
    let random = 0;
    const sockets: NodeNet.Socket[] = [];
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: (_path, args) => {
        const nodeId = args[args.indexOf("--node") + 1] ?? "";
        return fakeChild(
          (request, stdout) => {
            if (blocking && !request.startsWith("POST /api/pen/session")) {
              active++;
              if (active === 64) halfStarted();
              if (active === 128) allStarted();
              return;
            }
            const body = request.startsWith("POST /api/pen/session")
              ? JSON.stringify({
                  kind: "proxy",
                  token: "secret",
                  expiresAt: "2099-01-01T00:00:00.000Z",
                  scopes: HUB_PROXY_NODE_SCOPE_CEILING,
                })
              : "ok";
            stdout.end(
              `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
            );
          },
          true,
          { ...pin, nodeId },
        );
      },
      randomBytes: () => {
        const bytes = Buffer.alloc(32);
        bytes.writeUInt16BE(++random);
        return bytes;
      },
      appOrigins: ["goat://app"],
    });
    try {
      const urls: URL[] = [];
      for (const letter of "abcdefghi") {
        const route = await gateway.open({ ...pin, nodeId: "a".repeat(25) + letter });
        if (route.kind !== "open") throw new Error("route refused");
        urls.push(new URL(route.httpBaseUrl));
        expect(
          (await fetchUrl(`${route.httpBaseUrl}/api/projects`, { origin: "goat://app" })).status,
        ).toBe(200);
      }
      blocking = true;
      for (const url of urls.slice(0, 8)) {
        const socket = NodeNet.connect(Number(url.port), "127.0.0.1", () =>
          socket.write(
            `GET ${url.pathname}/api/projects HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: goat://app\r\n\r\n`.repeat(
              8,
            ),
          ),
        );
        socket.on("error", () => {});
        sockets.push(socket);
      }
      await half;
      for (let i = 0; i < sockets.length; i++) {
        const url = urls[i];
        const socket = sockets[i];
        if (!url || !socket) throw new Error("missing socket");
        socket.write(
          `GET ${url.pathname}/api/projects HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: goat://app\r\n\r\n`.repeat(
            8,
          ),
        );
      }
      await started;
      const url = urls[8];
      if (!url) throw new Error("missing route");
      const requests = Array.from({ length: 9 }, () =>
        fetchUrl(`${url.href}/api/projects`, { origin: "goat://app" }).catch(() => ({
          status: 0,
          body: "",
        })),
      );
      expect((await Promise.race(requests)).status).toBe(503);
      expect(active).toBe(128);
      for (const socket of sockets) socket.destroy();
      await gateway.dispose();
      await Promise.all(requests);
    } finally {
      for (const socket of sockets) socket.destroy();
      await gateway.dispose();
    }
  });
  it("reaps an in-flight dial when membership is revoked before readiness", async () => {
    let state: "member" | "not-member" = "member";
    let changed = () => {};
    let spawned = () => {};
    const spawnedPromise = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    let killed = false;
    const gateway = makePenGateway({
      membership: {
        requireMember: async () => state,
        subscribe: (listener) => {
          changed = listener;
          return () => {};
        },
      },
      resolvePenBinary: async () => "/pen",
      spawn: () => {
        const child = fakeChild(undefined, false);
        child.once("exit", () => {
          killed = true;
        });
        spawned();
        return child;
      },
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const request = fetchUrl(`${route.httpBaseUrl}/api/projects`, { origin: "goat://app" }).catch(
        () => ({ status: 0, body: "" }),
      );
      await spawnedPromise;
      state = "not-member";
      changed();
      await request;
      await gateway.dispose();
      expect(killed).toBe(true);
    } finally {
      await gateway.dispose();
    }
  });
  it("caps live forwards at sixteen and refuses a ninth waiting request", async () => {
    let spawns = 0;
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () => {
        spawns++;
        const respond = spawns <= 2;
        return fakeChild((request, stdout) => {
          if (!respond) return;
          const body = request.startsWith("POST /api/pen/session")
            ? JSON.stringify({
                kind: "proxy",
                token: "secret",
                expiresAt: "2099-01-01T00:00:00.000Z",
                scopes: HUB_PROXY_NODE_SCOPE_CEILING,
              })
            : "ok";
          stdout.end(
            `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          );
        });
      },
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const url = `${route.httpBaseUrl}/api/projects`;
      expect((await fetchUrl(url, { origin: "goat://app" })).status).toBe(200);
      const requests = Array.from({ length: 25 }, () =>
        fetchUrl(url, { origin: "goat://app" }).catch(() => ({ status: 0, body: "" })),
      );
      expect((await Promise.race(requests)).status).toBe(503);
      expect(spawns).toBe(18);
      await gateway.close(pin);
      await Promise.all(requests);
    } finally {
      await gateway.dispose();
    }
  });
  it("caps pending dials at six and refuses a ninth waiting request", async () => {
    let spawns = 0;
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () => {
        spawns++;
        const ready = spawns <= 2;
        return fakeChild((request, stdout) => {
          const body = request.startsWith("POST /api/pen/session")
            ? JSON.stringify({
                kind: "proxy",
                token: "secret",
                expiresAt: "2099-01-01T00:00:00.000Z",
                scopes: HUB_PROXY_NODE_SCOPE_CEILING,
              })
            : "ok";
          stdout.end(
            `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          );
        }, ready);
      },
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const url = `${route.httpBaseUrl}/api/projects`;
      expect((await fetchUrl(url, { origin: "goat://app" })).status).toBe(200);
      const requests = Array.from({ length: 15 }, () =>
        fetchUrl(url, { origin: "goat://app" }).catch(() => ({ status: 0, body: "" })),
      );
      expect((await Promise.race(requests)).status).toBe(503);
      expect(spawns).toBe(8);
      await gateway.close(pin);
      await Promise.all(requests);
    } finally {
      await gateway.dispose();
    }
  });
  it("finishes a length-framed response even if the target keeps its pipe open", async () => {
    let targetKilled = false;
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () => {
        const proc = fakeChild((request, stdout) => {
          if (request.startsWith("POST /api/pen/session")) {
            const body = JSON.stringify({
              kind: "proxy",
              token: "secret",
              expiresAt: "2099-01-01T00:00:00.000Z",
              scopes: HUB_PROXY_NODE_SCOPE_CEILING,
            });
            stdout.end(
              `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
            );
          } else {
            expect(request).toContain("Connection: close");
            proc.once("exit", () => {
              targetKilled = true;
            });
            stdout.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
          }
        });
        return proc;
      },
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      expect(await fetchUrl(`${route.httpBaseUrl}/api/projects`, { origin: "goat://app" })).toEqual(
        { status: 200, body: "ok" },
      );
      expect(targetKilled).toBe(true);
    } finally {
      await gateway.dispose();
    }
  });
  it("refreshes a bearer within sixty seconds of expiry", async () => {
    let now = 0;
    let minted = 0;
    const expiry = "1970-01-01T00:05:00.000Z";
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () =>
        fakeChild((request, stdout) => {
          const isMint = request.startsWith("POST /api/pen/session");
          if (isMint) minted++;
          const body = isMint
            ? JSON.stringify({
                kind: "proxy",
                token: "secret",
                expiresAt: expiry,
                scopes: HUB_PROXY_NODE_SCOPE_CEILING,
              })
            : "ok";
          stdout.end(
            `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          );
        }),
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
      now: () => now,
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      await fetchUrl(`${route.httpBaseUrl}/api/projects`, { origin: "goat://app" });
      now = 241000;
      await fetchUrl(`${route.httpBaseUrl}/api/projects`, { origin: "goat://app" });
      expect(minted).toBe(2);
    } finally {
      await gateway.dispose();
    }
  });
  it("refuses more than 64 routes without creating another capability", async () => {
    let random = 0;
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () => fakeChild(),
      randomBytes: () => {
        const bytes = Buffer.alloc(32);
        bytes.writeUInt16BE(++random);
        return bytes;
      },
      appOrigins: ["goat://app"],
    });
    try {
      const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
      for (let i = 0; i < 64; i++) {
        const other = {
          ...pin,
          nodeId: "a".repeat(24) + alphabet[Math.floor(i / 32)] + alphabet[i % 32],
        };
        expect((await gateway.open(other)).kind).toBe("open");
      }
      expect(await gateway.open({ ...pin, nodeId: "a".repeat(24) + "ca" })).toEqual({
        kind: "refused",
        reason: "busy",
      });
      expect(random).toBe(64);
    } finally {
      await gateway.dispose();
    }
  });
  it("reaps a forward when its client disconnects", async () => {
    let requestArrived = () => {};
    const arrived = new Promise<void>((resolve) => {
      requestArrived = resolve;
    });
    let forwardKilled = () => {};
    const killed = new Promise<void>((resolve) => {
      forwardKilled = resolve;
    });
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () => {
        const proc = fakeChild((request, stdout) => {
          if (request.startsWith("POST /api/pen/session")) {
            const body = JSON.stringify({
              kind: "proxy",
              token: "secret",
              expiresAt: "2099-01-01T00:00:00.000Z",
              scopes: HUB_PROXY_NODE_SCOPE_CEILING,
            });
            stdout.end(
              `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
            );
          } else {
            proc.once("exit", forwardKilled);
            requestArrived();
          }
        });
        return proc;
      },
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const request = NodeHttp.get(`${route.httpBaseUrl}/api/projects`, {
        headers: { origin: "goat://app" },
      });
      request.on("error", () => {});
      await arrived;
      request.destroy();
      await killed;
    } finally {
      await gateway.dispose();
    }
  });
  it("strips cookies and target CORS while retaining gateway CORS and referrer policy", async () => {
    const requests: string[] = [];
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () =>
        fakeChild((request, stdout) => {
          requests.push(request);
          const body = request.startsWith("POST /api/pen/session")
            ? JSON.stringify({
                kind: "proxy",
                token: "secret",
                expiresAt: "2099-01-01T00:00:00.000Z",
                scopes: HUB_PROXY_NODE_SCOPE_CEILING,
              })
            : "ok";
          stdout.end(
            `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nSet-Cookie: bad=1\r\nAccess-Control-Allow-Origin: https://evil.example\r\nReferrer-Policy: unsafe-url\r\n\r\n${body}`,
          );
        }),
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const headers = await new Promise<NodeHttp.IncomingHttpHeaders>((resolve, reject) => {
        const req = NodeHttp.get(
          `${route.httpBaseUrl}/api/projects`,
          { headers: { origin: "goat://app", cookie: "private=1" } },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.headers));
          },
        );
        req.on("error", reject);
      });
      expect(headers["set-cookie"]).toBeUndefined();
      expect(headers["access-control-allow-origin"]).toBe("goat://app");
      expect(headers["referrer-policy"]).toBe("no-referrer");
      expect(requests[1]).not.toContain("private=1");
    } finally {
      await gateway.dispose();
    }
  });
  it("closing a pin while its open is in flight leaves no live capability", async () => {
    let finish = (_path: string | undefined) => {};
    const binary = new Promise<string | undefined>((resolve) => {
      finish = resolve;
    });
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: () => binary,
      spawn: () => fakeChild(),
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const opening = gateway.open(pin);
      const closing = gateway.close(pin);
      finish("/pen");
      const route = await opening;
      await closing;
      if (route.kind !== "open") throw new Error("the open in flight was refused");
      expect(
        (await fetchUrl(`${route.httpBaseUrl}/api/projects`, { origin: "goat://app" })).status,
      ).toBe(404);
    } finally {
      await gateway.dispose();
    }
  });
  it("holds client upgrade bytes until the validated 101", async () => {
    const wsKey = "dGhlIHNhbXBsZSBub25jZQ==";
    let upstream: NodeStream.PassThrough | undefined;
    let targetStdin: NodeJS.ReadableStream | undefined;
    let requestSeen = () => {};
    const requestReady = new Promise<void>((resolve) => {
      requestSeen = resolve;
    });
    let frameSeen = (_value: string) => {};
    let headWritten = false;
    let frameBeforeHead = false;
    const frameReady = new Promise<string>((resolve) => {
      frameSeen = resolve;
    });
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () => {
        const child = fakeChild((request, stdout) => {
          if (request.startsWith("POST /api/pen/session")) {
            const body = JSON.stringify({
              kind: "proxy",
              token: "secret",
              expiresAt: "2099-01-01T00:00:00.000Z",
              scopes: HUB_PROXY_NODE_SCOPE_CEILING,
            });
            stdout.end(
              `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
            );
          } else {
            upstream = stdout;
            const stdin = child.stdin;
            if (!(stdin instanceof NodeStream.PassThrough)) throw new Error("missing fake stdin");
            targetStdin = stdin;
            stdin.on("data", (bytes: Buffer) => {
              if (!headWritten) frameBeforeHead = true;
              frameSeen(bytes.toString());
            });
            requestSeen();
          }
        });
        return child;
      },
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    let socket: NodeNet.Socket | undefined;
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const url = new URL(route.httpBaseUrl);
      socket = NodeNet.connect(Number(url.port), "127.0.0.1", () =>
        socket!.write(
          `GET ${url.pathname}/ws HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: goat://app\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\nclient-frame`,
        ),
      );
      socket.on("error", () => {});
      await requestReady;
      expect(targetStdin).toBeDefined();
      headWritten = true;
      upstream!.write(
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${websocketAccept(wsKey)}\r\n\r\n`,
      );
      expect(await frameReady).toBe("client-frame");
      expect(frameBeforeHead).toBe(false);
    } finally {
      socket?.destroy();
      await gateway.dispose();
    }
  });
  it("relays a 401 and mints a new bearer for the next request", async () => {
    let minted = 0;
    let forwards = 0;
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () =>
        fakeChild((request, stdout) => {
          if (request.startsWith("POST /api/pen/session")) {
            minted++;
            const body = JSON.stringify({
              kind: "proxy",
              token: `secret-${minted}`,
              expiresAt: "2099-01-01T00:00:00.000Z",
              scopes: HUB_PROXY_NODE_SCOPE_CEILING,
            });
            stdout.end(
              `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
            );
          } else {
            forwards++;
            stdout.end(
              `HTTP/1.1 ${forwards === 1 ? "401 Unauthorized" : "200 OK"}\r\nContent-Length: 0\r\n\r\n`,
            );
          }
        }),
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      expect(
        (await fetchUrl(`${route.httpBaseUrl}/api/projects`, { origin: "goat://app" })).status,
      ).toBe(401);
      expect(
        (await fetchUrl(`${route.httpBaseUrl}/api/projects`, { origin: "goat://app" })).status,
      ).toBe(200);
      expect(minted).toBe(2);
    } finally {
      await gateway.dispose();
    }
  });
  it.each([
    ["HEAD with a length", "HEAD", "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n", 200, ""],
    ["204", "GET", "HTTP/1.1 204 No Content\r\n\r\n", 204, ""],
    ["304", "GET", "HTTP/1.1 304 Not Modified\r\n\r\n", 304, ""],
    [
      "chunked",
      "GET",
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n",
      200,
      "ok",
    ],
    // Without a length the end of the pipe is the only end, and a cut body would look complete.
    ["close delimited", "GET", "HTTP/1.1 200 OK\r\n\r\nok", 502, ""],
    ["redirect", "GET", "HTTP/1.1 302 Found\r\nContent-Length: 0\r\n\r\n", 502, ""],
    ["informational", "GET", "HTTP/1.1 103 Early Hints\r\n\r\n", 502, ""],
  ])("reframes %s responses", async (_name, method, upstream, status, expected) => {
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () =>
        fakeChild((request, stdout) => {
          if (request.startsWith("POST /api/pen/session")) {
            const body = JSON.stringify({
              kind: "proxy",
              token: "secret",
              expiresAt: "2099-01-01T00:00:00.000Z",
              scopes: HUB_PROXY_NODE_SCOPE_CEILING,
            });
            stdout.end(
              `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
            );
          } else stdout.end(upstream);
        }),
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      expect(
        await fetchUrl(`${route.httpBaseUrl}/api/projects`, { origin: "goat://app" }, method),
      ).toEqual({ status, body: expected });
    } finally {
      await gateway.dispose();
    }
  });
  it("judges each pipelined request independently and forwards no appended request bytes", async () => {
    const requests: string[] = [];
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () =>
        fakeChild((request, stdout) => {
          requests.push(request);
          const body = request.startsWith("POST /api/pen/session")
            ? JSON.stringify({
                kind: "proxy",
                token: "secret",
                expiresAt: "2099-01-01T00:00:00.000Z",
                scopes: HUB_PROXY_NODE_SCOPE_CEILING,
              })
            : "ok";
          stdout.end(
            `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          );
        }),
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const url = new URL(route.httpBaseUrl);
      const result = await new Promise<string>((resolve, reject) => {
        const socket = NodeNet.connect(Number(url.port), "127.0.0.1", () =>
          socket.write(
            `GET ${url.pathname}/api/projects HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: goat://app\r\n\r\nGET /pen-route/${"b".repeat(43)}/api/projects HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: goat://app\r\nConnection: close\r\n\r\n`,
          ),
        );
        let data = "";
        socket.on("data", (chunk) => {
          data += chunk.toString();
        });
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });
      expect(result).toContain("HTTP/1.1 200");
      expect(result).toContain("HTTP/1.1 404");
      expect(requests).toHaveLength(2);
      expect(requests[1]).not.toContain("/pen-route/");
    } finally {
      await gateway.dispose();
    }
  });
  it("retains a route while membership is unavailable and removes it on departure", async () => {
    let state: "member" | "unavailable" | "not-member" = "member";
    let changed = () => {};
    let spawns = 0;
    const gateway = makePenGateway({
      membership: {
        requireMember: async () => state,
        subscribe: (listener) => {
          changed = listener;
          return () => {};
        },
      },
      resolvePenBinary: async () => "/pen",
      spawn: () => {
        spawns++;
        return fakeChild();
      },
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      state = "unavailable";
      changed();
      expect(
        (await fetchUrl(`${route.httpBaseUrl}/api/projects`, { origin: "goat://app" })).status,
      ).toBe(503);
      expect(spawns).toBe(0);
      state = "not-member";
      changed();
      await Promise.resolve();
      expect(
        (await fetchUrl(`${route.httpBaseUrl}/api/projects`, { origin: "goat://app" })).status,
      ).toBe(404);
    } finally {
      await gateway.dispose();
    }
  });
  it("returns a validated uncompressed WebSocket upgrade and its coalesced bytes", async () => {
    const wsKey = "dGhlIHNhbXBsZSBub25jZQ==";
    const requests: string[] = [];
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () =>
        fakeChild((request, stdout) => {
          requests.push(request);
          if (request.startsWith("POST /api/pen/session")) {
            const body = JSON.stringify({
              kind: "proxy",
              token: "private-token",
              expiresAt: "2099-01-01T00:00:00.000Z",
              scopes: HUB_PROXY_NODE_SCOPE_CEILING,
            });
            stdout.end(
              `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
            );
          } else
            stdout.write(
              `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${websocketAccept(wsKey)}\r\n\r\nhello`,
            );
        }),
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const received = await new Promise<string>((resolve, reject) => {
        const req = NodeHttp.request(`${route.httpBaseUrl}/ws`, {
          headers: {
            origin: "goat://app",
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-key": wsKey,
            "sec-websocket-version": "13",
            "sec-websocket-extensions": "permessage-deflate",
          },
        });
        req.on("upgrade", (_res, socket, head) => {
          socket.destroy();
          resolve(head.toString());
        });
        req.on("error", reject);
        req.end();
      });
      expect(received).toBe("hello");
      expect(requests[1]).not.toContain("permessage-deflate");
    } finally {
      await gateway.dispose();
    }
  });
  it("mints a private proxy bearer and forwards a parsed response", async () => {
    const requests: string[] = [];
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () =>
        fakeChild((request, stdout) => {
          requests.push(request);
          const body = request.startsWith("POST /api/pen/session")
            ? JSON.stringify({
                kind: "proxy",
                token: "private-token",
                expiresAt: "2099-01-01T00:00:00.000Z",
                scopes: HUB_PROXY_NODE_SCOPE_CEILING,
              })
            : "visible";
          stdout.end(
            `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nSet-Cookie: secret\r\n\r\n${body}`,
          );
        }),
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const route = await gateway.open(pin);
      if (route.kind !== "open") throw new Error("route refused");
      const response = await fetchUrl(`${route.httpBaseUrl}/api/projects`, {
        origin: "goat://app",
      });
      expect(response).toEqual({ status: 200, body: "visible" });
      expect(requests).toHaveLength(2);
      expect(requests[1]).toContain("authorization: Bearer private-token");
      expect(response.body).not.toContain("private-token");
    } finally {
      await gateway.dispose();
    }
  });
  it("returns one route per pin and refuses wrong origin before spawning", async () => {
    let spawns = 0;
    const gateway = makePenGateway({
      membership: { requireMember: async () => "member", subscribe: () => () => {} },
      resolvePenBinary: async () => "/pen",
      spawn: () => {
        spawns++;
        return fakeChild();
      },
      randomBytes: () => Buffer.alloc(32, 1),
      appOrigins: ["goat://app"],
    });
    try {
      const first = await gateway.open(pin);
      expect(first.kind).toBe("open");
      expect(await gateway.open(pin)).toEqual(first);
      if (first.kind !== "open") throw new Error("route refused");
      expect(
        (await fetchUrl(`${first.httpBaseUrl}/api/projects`, { origin: "https://evil.example" }))
          .status,
      ).toBe(403);
      expect(spawns).toBe(0);
      await gateway.close(pin);
      expect(
        (await fetchUrl(`${first.httpBaseUrl}/api/projects`, { origin: "goat://app" })).status,
      ).toBe(404);
    } finally {
      await gateway.dispose();
    }
  });
});
