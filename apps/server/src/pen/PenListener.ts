// @effect-diagnostics nodeBuiltinImport:off -- the Pen listener owns raw loopback sockets.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";

import { guardErrors } from "@goat/shared/errorGuards";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import { attachPenConnection } from "../auth/connectionContext.ts";
import { guardHttpResponseWriteErrors } from "../httpResponseErrorGuard.ts";
import { PenHandshakeFailed, type PenPin, proveDelivery } from "./penHandshake.ts";
import { admitPenRequest } from "./penRoutes.ts";

/** The program's limits of pen-protocol CONTRACT "Local delivery". */
export const PEN_LISTENER_LIMITS = {
  handshakes: 16,
  perMember: 32,
  total: 128,
  handshakeDeadline: Duration.seconds(3),
  idle: Duration.seconds(120),
} as const;

export interface PenListenerOptions {
  readonly pin: PenPin;
  readonly generation: number;
  /** Receives every admitted request and upgrade, as if it had parsed them itself. */
  readonly mainServer: NodeHttp.Server;
  /** The platform gate, rerun on every accept; false refuses the socket and calls onUnsafe. */
  readonly admitAccept: Effect.Effect<boolean>;
  readonly onUnsafe: Effect.Effect<void>;
  /** The program's nonce for each handshake; tests pin it to replay the shared vectors. */
  readonly nonce?: () => Uint8Array;
  /** Runs each time a connection's 120 s idle timer starts; tests wait on it before moving the clock. */
  readonly onIdleArmed?: Effect.Effect<void>;
}

export class PenListenError extends Data.TaggedError("PenListenError")<{
  readonly reason: string;
}> {}

interface Activity {
  open: number;
  upgraded: boolean;
  marks: number;
  readonly changed: Queue.Queue<void>;
}

const refuseUpgrade = (socket: NodeStream.Duplex, status: 401 | 404) =>
  socket.end(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Not Found"}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
  );

const isUpgrade = (request: NodeHttp.IncomingMessage) =>
  (request.headers.upgrade ?? "").toLowerCase() === "websocket";

/**
 * A loopback listener that completes Pen's local proof before any byte reaches the HTTP stack,
 * then parses the connection in a private, never-listening server whose raw gate admits only the
 * Pen route table and hands what it admits to the main server. Lives as long as its scope.
 */
export const make = Effect.fn("PenListener.make")(function* (options: PenListenerOptions) {
  const runFork = yield* FiberSet.makeRuntime<never>();
  const activity = new WeakMap<object, Activity>();
  const perMember = new Map<string, number>();
  const sockets = new Set<NodeNet.Socket>();
  let handshaking = 0;
  let total = 0;

  const note = (state: Activity | undefined, change: (state: Activity) => void) => {
    if (state === undefined) return;
    change(state);
    state.marks += 1;
    Queue.offerUnsafe(state.changed, undefined);
  };

  const parser = guardHttpResponseWriteErrors(guardErrors(NodeHttp.createServer(), () => {}));
  parser.requestTimeout = options.mainServer.requestTimeout;
  parser.headersTimeout = options.mainServer.headersTimeout;
  // Idle closing is the listener's own 120 s rule; Node's keep-alive timer would close sooner.
  parser.keepAliveTimeout = 0;
  parser.on("clientError", (_error, socket) => socket.destroy());
  parser.on("request", (request, response) => {
    const admission = admitPenRequest({
      method: request.method ?? "",
      url: request.url ?? "",
      upgrade: false,
      headers: request.headers,
    });
    if (admission.kind === "refuse") {
      response.writeHead(admission.status, { connection: "close", "content-length": "0" }).end();
      return;
    }
    const state = activity.get(request.socket);
    note(state, (current) => {
      current.open += 1;
    });
    response.once("close", () =>
      note(state, (current) => {
        current.open -= 1;
      }),
    );
    options.mainServer.emit("request", request, response);
  });
  parser.on("upgrade", (request, socket, head) => {
    const admission = admitPenRequest({
      method: request.method ?? "",
      url: request.url ?? "",
      upgrade: isUpgrade(request),
      headers: request.headers,
    });
    if (admission.kind === "refuse") return refuseUpgrade(socket, admission.status);
    note(activity.get(request.socket), (current) => {
      current.upgraded = true;
    });
    options.mainServer.emit("upgrade", request, socket, head);
  });

  // Per connection, not per request, so a span each is cheap.
  const idleWatch = Effect.fn("PenListener.idleWatch")(function* (
    socket: NodeNet.Socket,
    state: Activity,
  ) {
    for (;;) {
      if (state.open > 0 || state.upgraded) {
        yield* Queue.take(state.changed);
        continue;
      }
      const mark = state.marks;
      // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off -- the observer must start after the timer arms.
      const lapsed = yield* Effect.raceFirst(
        Effect.sleep(PEN_LISTENER_LIMITS.idle).pipe(Effect.as(true)),
        // The second branch starts after the first has armed its timer.
        (options.onIdleArmed ?? Effect.void).pipe(
          Effect.andThen(Queue.take(state.changed)),
          Effect.as(false),
        ),
      );
      if (lapsed && state.open === 0 && !state.upgraded && state.marks === mark) {
        socket.destroy();
        return;
      }
    }
  });

  const serve = Effect.fn("PenListener.serve")(function* (
    socket: NodeNet.Socket,
    peer: Effect.Success<ReturnType<typeof proveDelivery>>,
  ) {
    const { nodeId } = peer.peer;
    const member = perMember.get(nodeId) ?? 0;
    if (member >= PEN_LISTENER_LIMITS.perMember || total >= PEN_LISTENER_LIMITS.total)
      return socket.destroy();
    perMember.set(nodeId, member + 1);
    total += 1;
    const closed = yield* Deferred.make<void>();
    let open = true;
    socket.once("close", () => {
      open = false;
      total -= 1;
      const left = (perMember.get(nodeId) ?? 1) - 1;
      if (left === 0) perMember.delete(nodeId);
      else perMember.set(nodeId, left);
      Deferred.doneUnsafe(closed, Effect.void);
    });
    const attached = attachPenConnection(socket, {
      kind: "pen",
      peer: peer.peer,
      connectionId: NodeCrypto.randomUUID(),
      generation: options.generation,
      alive: () => open && !socket.destroyed,
    });
    if (!attached) return socket.destroy();
    const state: Activity = {
      open: 0,
      upgraded: false,
      marks: 0,
      changed: yield* Queue.sliding<void>(1),
    };
    activity.set(socket, state);
    if (peer.rest.length > 0) socket.unshift(peer.rest);
    parser.emit("connection", socket);
    socket.resume();
    yield* Effect.raceFirst(idleWatch(socket, state), Deferred.await(closed));
  });

  /** Runs with one handshake slot already taken; gives it back when the proof ends. */
  const accept = Effect.fn("PenListener.accept")(function* (socket: NodeNet.Socket) {
    const proven = yield* Effect.gen(function* () {
      if (!(yield* options.admitAccept)) {
        socket.destroy();
        yield* options.onUnsafe;
        return Option.none();
      }
      return yield* proveDelivery(socket, options.pin, options.nonce).pipe(
        Effect.timeoutOrElse({
          duration: PEN_LISTENER_LIMITS.handshakeDeadline,
          orElse: () => Effect.fail(new PenHandshakeFailed()),
        }),
        Effect.option,
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          handshaking -= 1;
        }),
      ),
    );
    if (Option.isNone(proven)) return socket.destroy();
    yield* serve(socket, proven.value);
  });

  const server = guardErrors(NodeNet.createServer(), () => {});
  server.on("connection", (socket) => {
    socket.on("error", () => socket.destroy());
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (handshaking >= PEN_LISTENER_LIMITS.handshakes) return socket.destroy();
    handshaking += 1;
    runFork(accept(socket));
  });
  yield* Effect.acquireRelease(
    Effect.callback<void, PenListenError>((resume) => {
      server.once("error", (error) =>
        resume(
          Effect.fail(
            new PenListenError({ reason: "The Pen listener could not start: " + error.message }),
          ),
        ),
      );
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.sync(() => {
        server.close();
        for (const socket of sockets) socket.destroy();
        parser.close();
      }),
  );
  const address = server.address();
  if (typeof address !== "object" || address === null)
    return yield* Effect.die(new Error("the Pen listener has no address"));
  return {
    port: address.port,
    /** Ends every Pen connection now; sessions bound to them fail admitBinding from then on. */
    closeAll: Effect.sync(() => {
      for (const socket of sockets) socket.destroy();
    }),
  };
});

export type PenListener = Effect.Success<ReturnType<typeof make>>;
