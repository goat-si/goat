// The relay client socket (CONTRACT "Relay", design 10.1): binary messages, ping, cumulative acks, the 1 MiB cap,
// and bounds on what is held in either direction.
import { PenError, reportListenerError } from "./errors.ts";
import type { Clock, Timer } from "./runtime.ts";

export const RELAY_LIMITS = Object.freeze({
  message: 1024 * 1024,
  ackEvery: 64 * 1024,
  pingMs: 30_000,
  /** Held before a session takes the link. */
  heldMessages: 64,
  heldBytes: 1024 * 1024,
  /** Data waits above this many buffered bytes. */
  sendWait: 1024 * 1024,
  /** Buffered bytes past which the socket is stalled for good. */
  sendMax: 4 * 1024 * 1024,
  stallMs: 30_000,
  recheckMs: 25,
} as const);

export interface RelaySocketEvent {
  readonly data?: unknown;
  readonly code?: number;
}

/**
 * A factory's socket: no extension offered, no redirect, TLS and host verified, any close code 1000-4999 sent, and
 * bufferedAmount kept (React Native's global WebSocket keeps none, so it is no factory: F1, S9). An event it
 * dispatches synchronously from send() or close() waits, in arrival order, until the link's current step returns.
 */
export interface RelaySocketLike {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  readonly extensions?: string | undefined;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: RelaySocketEvent) => void,
  ): void;
  removeEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: RelaySocketEvent) => void,
  ): void;
}

export type RelaySocketFactory = (url: string) => RelaySocketLike;

export interface RelayLink {
  readonly relay: string;
  /** The next binary message, before a receiver is attached. Rejects with relay-closed when the socket closes. */
  receive(): Promise<Uint8Array>;
  /** From now on every binary message goes to the receiver synchronously, in order (held ones first). Once per link. */
  attach(receiver: (message: Uint8Array) => void, onClose?: (code: number) => void): void;
  send(message: Uint8Array): void;
  /** Sends the text ping used by the ping race. */
  ping(): void;
  /** Resolves on the first pong. */
  readonly pong: Promise<void>;
  /** Resolves when fewer than 1 MiB are buffered; rejects when the link closes. */
  writable(): Promise<void>;
  close(code: number): void;
  /** The close code: the socket's, the one this side sent, or 1006 when the close carried none. */
  readonly closed: Promise<number>;
}

export interface PendingDial {
  readonly opened: Promise<RelayLink>;
  /** Gives up on a dial that has not opened (closing a socket that did open with 1000). */
  abandon(): void;
}

// The phone dials only wss on port 443 (design 9.3: the compiled relay list), so no port is accepted for wss; ws with a
// port is for loopback test relays only.
const RELAY_ORIGIN =
  /^(?:wss:\/\/[a-z0-9.-]+|ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?)$/;

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export function dialRelay(options: {
  readonly relay: string;
  readonly nodeId: string;
  readonly factory: RelaySocketFactory;
  readonly clock: Clock;
}): PendingDial {
  if (!RELAY_ORIGIN.test(options.relay)) {
    throw new PenError("relay-url", "a relay is a wss origin (ws only on a loopback host)");
  }
  if (!/^[a-z2-7]{26}$/.test(options.nodeId))
    throw new PenError("node-id", "a node id is 26 base32 characters");
  const socket = options.factory(options.relay + "/v1/client/" + options.nodeId);
  socket.binaryType = "arraybuffer";
  const link = new Link(options.relay, socket, options.clock);
  return { opened: link.opened, abandon: () => link.abandon() };
}

class Link implements RelayLink {
  readonly opened: Promise<RelayLink>;
  readonly pong: Promise<void>;
  readonly closed: Promise<number>;
  readonly relay: string;
  readonly socket: RelaySocketLike;
  readonly clock: Clock;
  #resolveOpened!: (link: RelayLink) => void;
  #rejectOpened!: (error: unknown) => void;
  #resolvePong!: () => void;
  #resolveClosed!: (code: number) => void;
  #state: "connecting" | "open" | "closed" = "connecting";
  /** Counts this side's close requests: one made during a held-message drain stops it, closed link or not. */
  #closeRequests = 0;
  /** While held messages are handed over, a peer close waits: its notice comes after the drain. */
  #draining = false;
  #closeDeferred = false;
  #attached = false;
  /** Set while #finish closes the socket: an observer attached meanwhile hears of the close from #finish, after it. */
  #finishing = false;
  /** Socket events that came while the link was inside a socket call or another event, in arrival order. */
  #queued: Array<() => void> = [];
  #depth = 0;
  /** The observer last told of the close: none is told twice, even when attach() and #finish() both reach it. */
  #toldClose: ((code: number) => void) | undefined;
  #closeCode = 1006;
  #received = 0;
  #acked = 0;
  #held: Array<Uint8Array> = [];
  #heldBytes = 0;
  #receivers: Array<{ resolve: (message: Uint8Array) => void; reject: (error: unknown) => void }> =
    [];
  #receiver: ((message: Uint8Array) => void) | undefined;
  #onClose: ((code: number) => void) | undefined;
  #pingTimer: Timer | undefined;
  #recheckTimer: Timer | undefined;
  #stallSince: number | undefined;
  #writers: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

  constructor(relay: string, socket: RelaySocketLike, clock: Clock) {
    this.relay = relay;
    this.socket = socket;
    this.clock = clock;
    this.opened = new Promise((resolve, reject) => {
      this.#resolveOpened = resolve;
      this.#rejectOpened = reject;
    });
    this.pong = new Promise((resolve) => {
      this.#resolvePong = resolve;
    });
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    // A dial nobody awaits must not surface as an unhandled rejection.
    this.opened.catch(() => undefined);
    socket.addEventListener("open", () => this.#event(() => this.#onOpen()));
    socket.addEventListener("message", (event) => this.#event(() => this.#onMessage(event.data)));
    socket.addEventListener("close", (event) =>
      this.#event(() => this.#finish(typeof event.code === "number" ? event.code : 1006, false)),
    );
    // A refused or broken connection reports an error (Node's ws throws an error event nobody listens to): the link
    // ends 1006 at once and closes the socket, and the close event that may follow changes nothing.
    socket.addEventListener("error", () =>
      this.#event(() => {
        if (this.#state === "closed") return;
        this.#finish(1006, false, () => this.#closeSocket(undefined));
      }),
    );
  }

  /** Handles a socket event now, or after the current step when one is under way (a synchronous socket). */
  #event(handle: () => void): void {
    if (this.#depth === 0) {
      this.#step(handle);
      return;
    }
    if (this.#queued.length >= RELAY_LIMITS.heldMessages) {
      this.#queued = [];
      this.close(4408);
      return;
    }
    this.#queued.push(handle);
  }

  /** Runs one step with socket events held back, then handles those that came meanwhile, one step each. */
  #step(run: () => void): void {
    this.#depth += 1;
    try {
      run();
    } finally {
      this.#depth -= 1;
      if (this.#depth === 0) {
        for (let next = this.#queued.shift(); next !== undefined; next = this.#queued.shift()) {
          this.#depth += 1;
          try {
            next();
          } catch (error) {
            reportListenerError(error);
          } finally {
            this.#depth -= 1;
          }
        }
      }
    }
  }

  #onOpen(): void {
    if (this.#state !== "connecting") return;
    this.#state = "open";
    if (typeof this.socket.extensions === "string" && this.socket.extensions !== "") {
      this.#rejectOpened(
        new PenError("relay-extension", "the relay socket negotiated an extension"),
      );
      this.close(4402);
      return;
    }
    this.#schedulePing();
    this.#resolveOpened(this);
  }

  #schedulePing(): void {
    this.#pingTimer = this.clock.setTimer(RELAY_LIMITS.pingMs, () => {
      if (this.#state !== "open") return;
      this.#sendControl("ping");
      if (this.#state === "open") this.#schedulePing();
    });
  }

  #onMessage(data: unknown): void {
    if (this.#state !== "open") return;
    if (typeof data === "string") {
      if (data === "pong") this.#resolvePong();
      else this.close(1003);
      return;
    }
    const bytes = toBytes(data);
    if (bytes === null) {
      this.close(1003);
      return;
    }
    if (bytes.length > RELAY_LIMITS.message) {
      this.close(1009);
      return;
    }
    this.#received += bytes.length;
    if (this.#received - this.#acked >= RELAY_LIMITS.ackEvery) {
      this.#acked = this.#received;
      this.#sendControl("a:" + this.#received);
      if (this.#state !== "open") return;
    }
    const message = bytes.slice();
    if (this.#receiver !== undefined) {
      this.#deliver(this.#receiver, message);
      return;
    }
    const waiter = this.#receivers.shift();
    if (waiter !== undefined) {
      waiter.resolve(message);
      return;
    }
    if (
      this.#held.length >= RELAY_LIMITS.heldMessages ||
      this.#heldBytes + message.length > RELAY_LIMITS.heldBytes
    ) {
      this.close(4408);
      return;
    }
    this.#held.push(message);
    this.#heldBytes += message.length;
  }

  receive(): Promise<Uint8Array> {
    const held = this.#held.shift();
    if (held !== undefined) {
      this.#heldBytes -= held.length;
      return Promise.resolve(held);
    }
    if (this.#state === "closed") return Promise.reject(this.#closedError());
    return new Promise((resolve, reject) => this.#receivers.push({ resolve, reject }));
  }

  attach(receiver: (message: Uint8Array) => void, onClose?: (code: number) => void): void {
    // One receiver per link (a SecureSession takes it): a second, reentrant or later, could replace or lose the first
    // one's close notice.
    if (this.#attached) throw new PenError("relay-attached", "a relay link takes one receiver");
    this.#attached = true;
    this.#step(() => this.#takeHeld(receiver, onClose));
  }

  #takeHeld(receiver: (message: Uint8Array) => void, onClose?: (code: number) => void): void {
    this.#onClose = onClose;
    const closedBefore = this.#state === "closed";
    const requests = this.#closeRequests;
    // Held messages go first and in order, with any that arrive meanwhile (they are held, as the receiver is not set
    // yet). They arrived before any close, so a peer close does not stop the drain; only this side's close request or
    // a throwing receiver does. The close notice, from before or during the drain, comes once, after it.
    this.#draining = true;
    try {
      while (this.#closeRequests === requests) {
        const message = this.#held.shift();
        if (message === undefined) break;
        this.#heldBytes -= message.length;
        this.#deliver(receiver, message);
      }
    } finally {
      this.#draining = false;
    }
    this.#held = [];
    this.#heldBytes = 0;
    this.#receiver = receiver;
    if ((closedBefore || this.#closeDeferred) && !this.#finishing) {
      this.#closeDeferred = false;
      this.#notifyClose();
    }
  }

  /** A receiver that throws ends the link (1011, WebSocket's internal error) and is reported; nothing escapes. */
  #deliver(receiver: (message: Uint8Array) => void, message: Uint8Array): void {
    try {
      receiver(message);
    } catch (error) {
      this.close(1011);
      reportListenerError(error);
    }
  }

  send(message: Uint8Array): void {
    if (this.#state !== "open") throw this.#closedError();
    if (message.length > RELAY_LIMITS.message) {
      throw new PenError("message-too-large", "a relay message is at most 1 MiB");
    }
    try {
      this.#step(() => this.socket.send(message));
    } catch (error) {
      this.#abort();
      throw error;
    }
    this.#checkBuffered();
  }

  ping(): void {
    this.#sendText("ping");
  }

  #sendText(text: string): void {
    if (this.#state !== "open") return;
    try {
      this.#step(() => this.socket.send(text));
    } catch (error) {
      this.#abort();
      throw error;
    }
    this.#checkBuffered();
  }

  /**
   * A ping or an ack sent from a timer or a message callback: a failure has already finished the link (1006 for a
   * refused send, 4408 for an unreadable buffer), and the link's close is how its users learn of it.
   */
  #sendControl(text: string): void {
    try {
      this.#sendText(text);
    } catch {
      // The link is closed; its waiters were woken by #finish.
    }
  }

  writable(): Promise<void> {
    if (this.#state === "closed") return Promise.reject(this.#closedError());
    if (this.#buffered() < RELAY_LIMITS.sendWait) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#writers.push({ resolve, reject });
      this.#checkBuffered();
    });
  }

  #buffered(): number {
    const value = this.socket.bufferedAmount;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      this.close(4408);
      throw new PenError("relay-buffer", "the relay socket does not report its buffered bytes", {
        closeCode: 4408,
      });
    }
    return value;
  }

  /** Enforces the outbound bounds: wait at 1 MiB, close 4408 past 4 MiB or after 30 s at or above 1 MiB. */
  #checkBuffered(): void {
    if (this.#state !== "open") return;
    const buffered = this.#buffered();
    if (buffered > RELAY_LIMITS.sendMax) {
      this.close(4408);
      return;
    }
    if (buffered < RELAY_LIMITS.sendWait) {
      this.#stallSince = undefined;
      for (const writer of this.#writers.splice(0)) writer.resolve();
      return;
    }
    this.#stallSince ??= this.clock.now();
    if (this.clock.now() - this.#stallSince >= RELAY_LIMITS.stallMs) {
      this.close(4408);
      return;
    }
    if (this.#recheckTimer === undefined) {
      this.#recheckTimer = this.clock.setTimer(RELAY_LIMITS.recheckMs, () => {
        this.#recheckTimer = undefined;
        try {
          this.#checkBuffered();
        } catch {
          // An unreadable buffer closed the link 4408 before throwing.
        }
      });
    }
  }

  close(code: number): void {
    this.#closeRequests += 1;
    if (this.#state === "closed") return;
    const socketCode = this.#state === "connecting" ? undefined : code;
    this.#finish(code, true, () => this.#closeSocket(socketCode));
  }

  /** Ends the link after the socket refused a send: 1006 locally, and the socket is closed with no code. */
  #abort(): void {
    this.#closeRequests += 1;
    if (this.#state === "closed") return;
    this.#finish(1006, true, () => this.#closeSocket(undefined));
  }

  /** Closes the socket; a socket that throws doing so is dropped. */
  #closeSocket(code: number | undefined): void {
    this.#step(() => {
      try {
        if (code === undefined) this.socket.close();
        else this.socket.close(code);
      } catch {
        // A socket that cannot even close is dropped; the link finishes either way.
      }
    });
  }

  abandon(): void {
    if (this.#state === "connecting") this.close(1000);
  }

  #closedError(): PenError {
    return new PenError("relay-closed", "the relay socket closed " + this.#closeCode, {
      closeCode: this.#closeCode,
    });
  }

  /**
   * Ends the link: the code is settled first (a socket that reports its close synchronously from close() cannot
   * replace it), then closeSocket runs, then the observer hears of it, so nothing it does can keep the socket open.
   */
  #finish(code: number, local: boolean, closeSocket?: () => void): void {
    if (this.#state === "closed") return;
    const wasConnecting = this.#state === "connecting";
    this.#state = "closed";
    this.#closeCode = code;
    this.#pingTimer?.cancel();
    this.#recheckTimer?.cancel();
    const error = this.#closedError();
    if (wasConnecting) {
      this.#rejectOpened(local ? new PenError("dial-abandoned", "the dial was abandoned") : error);
    }
    for (const waiter of this.#receivers.splice(0)) waiter.reject(error);
    for (const writer of this.#writers.splice(0)) writer.reject(error);
    this.#resolveClosed(code);
    this.#finishing = true;
    try {
      closeSocket?.();
    } finally {
      this.#finishing = false;
    }
    if (this.#draining) this.#closeDeferred = true;
    else this.#notifyClose();
  }

  #notifyClose(): void {
    const observer = this.#onClose;
    if (observer === undefined || observer === this.#toldClose) return;
    this.#toldClose = observer;
    try {
      observer(this.#closeCode);
    } catch (error) {
      reportListenerError(error);
    }
  }
}
