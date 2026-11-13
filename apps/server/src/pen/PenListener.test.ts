// @effect-diagnostics nodeBuiltinImport:off -- a fake Pen daemon dials the listener over loopback.
import type * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import { decodeKey32 } from "@goat/pen-protocol/service";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { connectionOf } from "../auth/connectionContext.ts";
import { createGuardedHttpServer } from "../httpResponseErrorGuard.ts";
import { dial, hello, member, PIN, prove, vector } from "./penDaemon.testkit.ts";
import * as PenListener from "./PenListener.ts";

const get = (path: string, extra = "") =>
  "GET " + path + " HTTP/1.1\r\nHost: pen\r\nAuthorization: Bearer x\r\n" + extra + "\r\n";

const harness = (options: { nonce?: () => Uint8Array } = {}) =>
  Effect.gen(function* () {
    const seen: Array<string> = [];
    const release = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const idleArmed = yield* Queue.unbounded<void>();
    let main: NodeHttp.Server | undefined;
    const record = Effect.map(HttpServerRequest.HttpServerRequest, (incoming) => {
      const connection = connectionOf(incoming);
      seen.push(connection?.kind === "pen" ? connection.peer.nodeId : String(connection?.kind));
      return HttpServerResponse.text("ok");
    });
    yield* Layer.build(
      HttpRouter.serve(
        Layer.mergeAll(
          HttpRouter.add("GET", "/api/projects", record),
          HttpRouter.add("GET", "/api/auth/session", record),
          HttpRouter.add("OPTIONS", "/api/projects", record),
          HttpRouter.add(
            "GET",
            "/api/orchestration/shell",
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(HttpServerResponse.text("shell")),
            ),
          ),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(
            () => {
              const server = createGuardedHttpServer();
              main = server;
              return server;
            },
            { port: 0, host: "127.0.0.1" },
          ),
        ),
      ),
    );
    const unsafe = yield* Deferred.make<void>();
    const listener = yield* PenListener.make({
      pin: PIN,
      generation: 1,
      mainServer: main!,
      admitAccept: Effect.succeed(true),
      onUnsafe: Deferred.succeed(unsafe, undefined).pipe(Effect.asVoid),
      onIdleArmed: Queue.offer(idleArmed, undefined).pipe(Effect.asVoid),
      ...options,
    });
    return { port: listener.port, seen, release, entered, idleArmed };
  });

it.effect("speaks the shared vector byte for byte and serves the caller it names", () =>
  Effect.gen(function* () {
    const { port, seen } = yield* harness({ nonce: () => decodeKey32(vector.ng)! });
    const client = yield* dial(port);
    client.socket.write(vector.line1);
    expect((yield* client.line()) + "\n").toBe(vector.line2);
    client.socket.write(vector.line3 + get("/api/projects"));
    expect(yield* client.line()).toBe("HTTP/1.1 200 OK\r");
    expect(seen).toEqual([vector.caller.nodeId]);
  }).pipe(Effect.scoped),
);

it.effect("refuses every reject line of the shared vectors with nothing more written", () =>
  Effect.gen(function* () {
    const { port, seen } = yield* harness({ nonce: () => decodeKey32(vector.ng)! });
    for (const reject of vector.rejectLine1) {
      const client = yield* dial(port);
      // A line without its LF is refused at EOF.
      if (reject.line.endsWith("\n")) client.socket.write(reject.line);
      else client.socket.end(reject.line);
      yield* Deferred.await(client.closed);
      expect(client.received(), reject.why).toBe("");
    }
    for (const reject of vector.rejectLine3) {
      const client = yield* dial(port);
      client.socket.write(vector.line1);
      yield* client.line();
      client.socket.write(reject.line + get("/api/projects"));
      yield* Deferred.await(client.closed);
      expect(client.received(), reject.why).toBe("");
    }
    expect(seen).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect(
  "refuses a wrong key, mesh or node, an oversized line and EOF, before any byte reaches HTTP",
  () =>
    Effect.gen(function* () {
      const { port, seen } = yield* harness();
      for (const options of [
        { key: new Uint8Array(32).fill(9) },
        { mesh: member("n") },
        { self: member("t") },
      ]) {
        const client = yield* prove(port, member("a"), { ...options, after: get("/api/projects") });
        yield* Deferred.await(client.closed);
        expect(client.received()).toBe("");
      }
      const long = yield* dial(port);
      long.socket.write("P".repeat(128));
      yield* Deferred.await(long.closed);
      expect(long.received()).toBe("");
      const longIdentity = yield* dial(port);
      longIdentity.socket.write(hello().line);
      yield* longIdentity.line();
      longIdentity.socket.write("{".repeat(2200));
      yield* Deferred.await(longIdentity.closed);
      expect(longIdentity.received()).toBe("");
      const eof = yield* dial(port);
      eof.socket.write(hello().line);
      yield* eof.line();
      eof.socket.end();
      yield* Deferred.await(eof.closed);
      expect(seen).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect("closes a stalled handshake at 3 seconds", () =>
  Effect.gen(function* () {
    const { port } = yield* harness();
    const client = yield* dial(port);
    client.socket.write(hello().line);
    yield* client.line();
    yield* TestClock.adjust("2999 millis");
    expect(yield* Deferred.isDone(client.closed)).toBe(false);
    yield* TestClock.adjust("1 millis");
    yield* Deferred.await(client.closed);
  }).pipe(Effect.scoped),
);

it.effect("refuses the 17th concurrent handshake at accept", () =>
  Effect.gen(function* () {
    const { port } = yield* harness();
    for (let index = 0; index < PenListener.PEN_LISTENER_LIMITS.handshakes; index += 1) {
      const client = yield* dial(port);
      client.socket.write(hello().line);
      yield* client.line();
    }
    const extra = yield* dial(port);
    extra.socket.write(hello().line);
    yield* Deferred.await(extra.closed);
    expect(extra.received()).toBe("");
  }).pipe(Effect.scoped),
);

it.effect(
  "404s off-table requests, upgrades, OPTIONS and cookies at the raw gate, before any handler",
  () =>
    Effect.gen(function* () {
      const { port, seen } = yield* harness();
      for (const raw of [
        get("/api/auth/websocket-ticket"),
        get("/api/auth/session?x=1"),
        get("/api/auth/session", "Connection: Upgrade\r\nUpgrade: websocket\r\n"),
        "OPTIONS /api/projects HTTP/1.1\r\nHost: pen\r\nAuthorization: Bearer x\r\n\r\n",
        get("http://pen/api/projects"),
        get("/api/projects", "Cookie: goat_session=x\r\n"),
        get("/api/projects", "Connection: Upgrade\r\nUpgrade: websocket\r\n"),
        get("/api/projects", "authorization: Bearer y\r\n"),
        get("/ws", "Authorization: Bearer y\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"),
      ]) {
        const client = yield* prove(port, member("a"), { after: raw });
        expect(yield* client.line(), raw).toBe("HTTP/1.1 404 Not Found\r");
      }
      expect(seen).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect(
  "closes connections past 32 per member and 128 in total; other members still connect",
  () =>
    Effect.gen(function* () {
      const { port } = yield* harness();
      const held: Array<unknown> = [];
      const open = (nodeId: string) =>
        Effect.gen(function* () {
          const client = yield* prove(port, nodeId, { after: get("/api/projects") });
          expect(yield* client.line()).toBe("HTTP/1.1 200 OK\r");
          held.push(client);
        });
      for (let index = 0; index < PenListener.PEN_LISTENER_LIMITS.perMember; index += 1)
        yield* open(member("a"));
      const overMember = yield* prove(port, member("a"), { after: get("/api/projects") });
      yield* Deferred.await(overMember.closed);
      expect(overMember.received()).toBe("");
      for (const letter of ["b", "c", "d"])
        for (let index = 0; index < PenListener.PEN_LISTENER_LIMITS.perMember; index += 1)
          yield* open(member(letter));
      const overTotal = yield* prove(port, member("e"), { after: get("/api/projects") });
      yield* Deferred.await(overTotal.closed);
      expect(overTotal.received()).toBe("");
      expect(held.length).toBe(128);
    }).pipe(Effect.scoped),
);

it.effect(
  "never closes a connection with an open request as idle; closes it 120 s after the last",
  () =>
    Effect.gen(function* () {
      const { port, release, entered, idleArmed } = yield* harness();
      const client = yield* prove(port, member("a"), { after: get("/api/orchestration/shell") });
      yield* Deferred.await(entered);
      yield* TestClock.adjust("121 seconds");
      expect(yield* Deferred.isDone(client.closed)).toBe(false);
      yield* Queue.clear(idleArmed);
      yield* Deferred.succeed(release, undefined);
      expect(yield* client.line()).toBe("HTTP/1.1 200 OK\r");
      yield* Queue.take(idleArmed);
      yield* TestClock.adjust("119 seconds");
      expect(yield* Deferred.isDone(client.closed)).toBe(false);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(client.closed);
    }).pipe(Effect.scoped),
);

it.effect("keeps serving after a malformed request and a reset during the handshake", () =>
  Effect.gen(function* () {
    const { port } = yield* harness();
    const garbage = yield* prove(port, member("a"), { after: "NOT HTTP\r\n\r\n" });
    yield* Deferred.await(garbage.closed);
    const reset = yield* dial(port);
    reset.socket.write(hello().line);
    yield* reset.line();
    reset.socket.resetAndDestroy();
    yield* Deferred.await(reset.closed);
    const client = yield* prove(port, member("a"), { after: get("/api/projects") });
    expect(yield* client.line()).toBe("HTTP/1.1 200 OK\r");
  }).pipe(Effect.scoped),
);
