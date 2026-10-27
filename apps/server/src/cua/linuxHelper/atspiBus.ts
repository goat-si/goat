// @effect-diagnostics globalTimers:off -- Call deadlines and the idle close around dbus-next's own promises.
import { DBusError, Message, type MessageBus, sessionBus } from "dbus-next";

/**
 * Method calls on the accessibility bus over one connection, opened at the first call and closed
 * once idle. dbus-next reads and writes the wire format; this keeps the rules the focus probe
 * depends on: a call goes to a unique name and is answered only by it, a connection that errs
 * fails every call on it, and an aborted call sends nothing more and stops waiting.
 */

export interface BusCall {
  readonly destination: string;
  readonly path: string;
  readonly iface: string;
  readonly member: string;
  readonly signature?: string;
  readonly body?: ReadonlyArray<unknown>;
}

export interface BusReply {
  readonly signature: string;
  readonly body: ReadonlyArray<unknown>;
  /** The connection that carried it, numbered from 1: bus names mean nothing across two. */
  readonly connection?: number;
}

/** One method call and its reply, or a rejection: a BusError for an error reply. */
export type AtspiCall = (call: BusCall, signal: AbortSignal) => Promise<BusReply>;

/** An error reply. The name comes from the message header, never from text. */
export class BusError extends Error {
  readonly errorName: string;
  constructor(errorName: string, message: string) {
    super(errorName + ": " + message);
    this.errorName = errorName;
  }
}

export const DAEMON = "org.freedesktop.DBus";
/** As gdbus was given: a call the app does not answer within this is a failed read. */
const CALL_TIMEOUT_MS = 1_000;
const SETUP_TIMEOUT_MS = 2_000;
const IDLE_CLOSE_MS = 10_000;

const aborted = () => new Error("The call was cancelled.");

/** promise, or a rejection as soon as signal aborts. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(aborted());
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

interface Connection {
  readonly id: number;
  readonly bus: MessageBus;
  /** Fails every call still waiting on this connection. */
  readonly failures: Set<(error: Error) => void>;
  ended: boolean;
}

function open(address: string, id: number): Promise<Connection> {
  const bus = sessionBus({ busAddress: address });
  const connection: Connection = { id, bus, failures: new Set(), ended: false };
  return new Promise<Connection>((resolve, reject) => {
    const setup = setTimeout(
      () => end(new Error("The accessibility bus did not let this in.")),
      SETUP_TIMEOUT_MS,
    );
    setup.unref();
    const end = (error: Error) => {
      clearTimeout(setup);
      if (connection.ended) return;
      connection.ended = true;
      for (const fail of connection.failures) fail(error);
      connection.failures.clear();
      bus.disconnect();
      reject(error);
    };
    // dbus-next reports an unreadable message, a dropped stream, and a refused Hello here.
    bus.on("error", (error: unknown) =>
      end(error instanceof Error ? error : new Error(String(error))),
    );
    bus.on("connect", () => {
      clearTimeout(setup);
      resolve(connection);
    });
  });
}

function send(connection: Connection, call: BusCall, signal: AbortSignal): Promise<BusReply> {
  if (signal.aborted) return Promise.reject(aborted());
  if (connection.ended) return Promise.reject(new Error("The accessibility bus connection ended."));
  return new Promise<BusReply>((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      connection.failures.delete(fail);
    };
    const fail = (error: Error) => {
      settle();
      reject(error);
    };
    const stop = () => fail(aborted());
    const timer = setTimeout(
      () => fail(new Error("The accessibility bus did not answer " + call.member + ".")),
      CALL_TIMEOUT_MS,
    );
    signal.addEventListener("abort", stop, { once: true });
    connection.failures.add(fail);
    const message = new Message({
      destination: call.destination,
      path: call.path,
      interface: call.iface,
      member: call.member,
      ...(call.signature ? { signature: call.signature, body: [...(call.body ?? [])] } : {}),
    });
    connection.bus.call(message).then(
      (reply) => {
        // Only the peer called answers; dbus-next matches replies by serial alone.
        if (reply === null || reply.sender !== call.destination)
          return fail(new Error("Another peer answered " + call.member + "."));
        settle();
        resolve({
          signature: reply.signature ?? "",
          body: reply.body ?? [],
          connection: connection.id,
        });
      },
      (error: unknown) => {
        if (!(error instanceof DBusError))
          return fail(error instanceof Error ? error : new Error(String(error)));
        // The bus daemon may refuse a call on the peer's behalf; that is only ever a failure.
        const from: unknown = error.reply?.sender;
        if (from !== call.destination && from !== DAEMON)
          return fail(new Error("Another peer answered " + call.member + "."));
        fail(new BusError(error.type, error.text));
      },
    );
  });
}

/**
 * Calls on the accessibility bus at `address`, over one connection opened at the first call,
 * opened again after it ends, and closed after a while without calls.
 */
export function makeAtspiBus(options: { readonly address: () => Promise<string> }): AtspiCall {
  let current: Promise<Connection> | undefined;
  let opened = 0;
  let calls = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const connection = () => {
    if (current !== undefined) return current;
    const attempt = options.address().then((address) => open(address, ++opened));
    current = attempt;
    const forget = () => {
      if (current === attempt) current = undefined;
    };
    attempt.then((made) => made.bus.on("error", forget), forget);
    return attempt;
  };
  return async (call, signal) => {
    if (!call.destination.startsWith(":") && call.destination !== DAEMON)
      throw new Error("A call goes to a unique name, so its answer can be checked.");
    if (idle !== undefined) clearTimeout(idle);
    calls++;
    try {
      const made = await untilAborted(connection(), signal);
      return await send(made, call, signal);
    } finally {
      if (--calls === 0) {
        idle = setTimeout(() => {
          const closing = current;
          current = undefined;
          void closing?.then(
            (made) => made.bus.disconnect(),
            () => undefined,
          );
        }, IDLE_CLOSE_MS);
        idle.unref();
      }
    }
  };
}
