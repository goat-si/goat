// @effect-diagnostics nodeBuiltinImport:off -- the context is keyed by the accepted Node socket.
import type * as NodeNet from "node:net";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

/** The caller a Pen listener proved for one connection (mesh link design §3). */
export interface PenPeer {
  readonly meshId: string;
  readonly nodeId: string;
  readonly signPub: string;
  readonly noisePub: string;
  readonly name: string;
}

export interface PenConnection {
  readonly kind: "pen";
  readonly peer: PenPeer;
  readonly connectionId: string;
  readonly generation: number;
  readonly alive: () => boolean;
}

/** Which listener accepted the socket a request arrived on; there is no default. */
export type ConnectionContext = { readonly kind: "main" } | PenConnection;

const bySocket = new WeakMap<object, ConnectionContext>();
const MAIN: ConnectionContext = Object.freeze({ kind: "main" });

/**
 * Marks sockets the main server itself accepted. Node's own http listener reassigns
 * socket.server, so this runs first; a socket another server injects gets no context.
 */
export const attachMainListener = (server: NodeNet.Server) => {
  server.prependListener("connection", (socket: NodeNet.Socket) => {
    if ((socket as { readonly server?: unknown }).server === server && !bySocket.has(socket))
      bySocket.set(socket, MAIN);
  });
};

/** Registers a proven Pen connection; a socket that already has a context keeps it and fails. */
export const attachPenConnection = (socket: object, connection: PenConnection): boolean => {
  if (bySocket.has(socket)) return false;
  bySocket.set(socket, connection);
  return true;
};

/** The connection a request arrived on, or undefined when no listener registered one. */
export const connectionOf = (
  request: HttpServerRequest.HttpServerRequest,
): ConnectionContext | undefined => {
  const source: unknown = request.source;
  if (typeof source !== "object" || source === null) return undefined;
  const socket = (source as { readonly socket?: unknown }).socket;
  return bySocket.get(typeof socket === "object" && socket !== null ? socket : source);
};

/** Test fixtures register an explicit context for a request source that has no socket. */
export const registerSourceForTest = (source: object, context: ConnectionContext) => {
  bySocket.set(source, context);
};
