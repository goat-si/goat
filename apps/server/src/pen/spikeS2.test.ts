// Spike S2 of the mesh link design: a loopback listener finishes a local handshake, then a separate
// non-listening parser server gates requests before re-emitting them on the main server, with the
// connection context readable from HttpServerRequest. Replaced by the Pen listener tests.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { expect } from "vitest";
import WebSocket from "ws";

type Ctx = { readonly kind: "main" } | { readonly kind: "pen"; readonly peer: string };
const contexts = new WeakMap<NodeNet.Socket, Ctx>();
const readCtx = (request: HttpServerRequest.HttpServerRequest) =>
  contexts.get(NodeHttpServerRequest.toIncomingMessage(request).socket as NodeNet.Socket) ?? null;

it.live(
  "S2: a socket handed over after a handshake carries its context into routes and upgrades",
  () =>
    Effect.gen(function* () {
      let httpServer: NodeHttp.Server | undefined;
      const routes = Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/ctx",
          Effect.map(HttpServerRequest.HttpServerRequest, (r) =>
            HttpServerResponse.jsonUnsafe(readCtx(r)),
          ),
        ),
        HttpRouter.add(
          "GET",
          "/ws",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const ctx = readCtx(request);
            const socket = yield* request.upgrade;
            yield* Effect.scoped(
              Effect.gen(function* () {
                const reader = yield* socket.reader;
                const writer = yield* socket.writer;
                yield* writer.write(JSON.stringify(ctx));
                yield* reader.pull.pipe(Effect.forever, Effect.ignore);
              }),
            );
            return HttpServerResponse.empty();
          }),
        ),
      );
      const services = yield* Layer.build(
        HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(
              () => {
                const server = NodeHttp.createServer();
                server.prependListener(
                  "connection",
                  (socket: NodeNet.Socket & { server?: unknown }) => {
                    if (socket.server === server) contexts.set(socket, { kind: "main" });
                  },
                );
                httpServer = server;
                return server;
              },
              { port: 0, host: "127.0.0.1", websocket: { perMessageDeflate: true } },
            ),
          ),
        ),
      );
      const mainUrl = HttpServer.formatAddress(
        Context.get(services, HttpServer.HttpServer).address,
      );

      const gateHits: string[] = [];
      const penParser = NodeHttp.createServer();
      penParser.on("request", (req, res) => {
        if (req.url === "/forbidden") {
          gateHits.push("refused " + req.url);
          res.writeHead(404).end();
          return;
        }
        httpServer!.emit("request", req, res);
      });
      penParser.on("upgrade", (req, socket, head) => {
        if (req.url !== "/ws") {
          gateHits.push("refused upgrade " + req.url);
          socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
          return;
        }
        httpServer!.emit("upgrade", req, socket, head);
      });
      const pen = NodeNet.createServer((socket) => {
        socket.write("PENSVC/1 nonce\n");
        let buffered = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
          buffered = Buffer.concat([buffered, chunk]);
          const lf = buffered.indexOf(0x0a);
          if (lf === -1) return;
          socket.off("data", onData);
          socket.pause();
          const rest = buffered.subarray(lf + 1);
          if (rest.length > 0) socket.unshift(rest);
          contexts.set(socket, { kind: "pen", peer: buffered.subarray(0, lf).toString() });
          penParser.emit("connection", socket);
          socket.resume();
        };
        socket.on("data", onData);
      });
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          pen.listen(0, "127.0.0.1", () => resume(Effect.void));
        }),
        () => Effect.sync(() => pen.close()),
      );
      const penPort = (pen.address() as NodeNet.AddressInfo).port;

      const dialPen = Effect.callback<NodeNet.Socket>((resume) => {
        const s = NodeNet.connect(penPort, "127.0.0.1");
        s.once("data", () => resume(Effect.succeed(s)));
      });
      const readAll = (s: NodeNet.Socket) =>
        Effect.callback<string>((resume) => {
          let out = "";
          s.on("data", (c) => {
            out += c.toString();
          });
          s.on("end", () => resume(Effect.succeed(out)));
        });

      // Identity line and the HTTP request coalesced in one write.
      const s1 = yield* dialPen;
      s1.write("member-A\nGET /ctx HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      const raw = yield* readAll(s1);
      expect(raw.slice(raw.indexOf("\r\n\r\n") + 4)).toBe(
        JSON.stringify({ kind: "pen", peer: "member-A" }),
      );

      // Keep-alive: two requests on one handed-over socket keep the same context.
      const s2 = yield* dialPen;
      s2.write("member-B\n");
      s2.write(
        "GET /ctx HTTP/1.1\r\nHost: x\r\n\r\nGET /ctx HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
      );
      const two = yield* readAll(s2);
      expect(two.split(JSON.stringify({ kind: "pen", peer: "member-B" })).length - 1).toBe(2);

      // The parser server refuses a path before the Effect app sees it.
      const s4 = yield* dialPen;
      s4.write("member-D\nGET /forbidden HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      const refused = yield* readAll(s4);
      expect(refused.startsWith("HTTP/1.1 404")).toBe(true);
      expect(gateHits).toEqual(["refused /forbidden"]);
      // A socket accepted by another server and injected without a context gets none.
      const stray = NodeNet.createServer((socket) => {
        httpServer!.emit("connection", socket);
      });
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          stray.listen(0, "127.0.0.1", () => resume(Effect.void));
        }),
        () => Effect.sync(() => stray.close()),
      );
      const s5 = NodeNet.connect((stray.address() as NodeNet.AddressInfo).port, "127.0.0.1");
      s5.write("GET /ctx HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      const strayOut = yield* readAll(s5);
      expect(strayOut.slice(strayOut.indexOf("\r\n\r\n") + 4)).toBe("null");
      // Main listener requests get the main context.
      const main = yield* Effect.promise(() => fetch(mainUrl + "/ctx").then((r) => r.json()));
      expect(main).toEqual({ kind: "main" });

      const mainWs = yield* Effect.callback<string>((resume) => {
        const ws = new WebSocket(mainUrl.replace("http", "ws") + "/ws");
        ws.once("message", (data) => {
          resume(Effect.succeed(data.toString()));
          ws.close();
        });
      });
      expect(mainWs).toBe(JSON.stringify({ kind: "main" }));
      // WebSocket upgrade over a handed-over socket sees the Pen context.
      const s3 = yield* dialPen;
      s3.write("member-C\n");
      const message = yield* Effect.callback<string>((resume) => {
        const ws = new WebSocket("ws://pen.invalid/ws", { createConnection: () => s3 });
        ws.once("message", (data) => {
          resume(Effect.succeed(data.toString()));
          ws.close();
        });
      });
      expect(message).toBe(JSON.stringify({ kind: "pen", peer: "member-C" }));
    }).pipe(Effect.scoped),
);
