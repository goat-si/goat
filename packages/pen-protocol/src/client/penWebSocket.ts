// A WebSocketLike over a Pen stream (design 10.1, 10.2), for the effect Socket.WebSocketConstructor seam.
// Frames out are masked with a fresh CSPRNG mask; frames in are decoded by FrameDecoder; one message is held at a time.
import { utf8Encode } from "./bytes.ts";
import { PenError } from "./errors.ts";
import { ResponseParser } from "./http1.ts";
import type { Clock, Random, Timer } from "./runtime.ts";
import type { PenStream } from "./stream.ts";
import {
  buildUpgradeRequest,
  closePayload,
  encodeFrame,
  type FrameEvent,
  FrameDecoder,
  Opcode,
  WEBSOCKET_LIMITS,
} from "./websocket.ts";

export const PEN_WEBSOCKET_LIMITS = {
  /** Frames waiting for stream credit. One frame of any allowed size is admitted when nothing waits. */
  outboundBytes: 4 * 1024 * 1024,
  outboundFrames: 1024,
  writePiece: 1024 * 1024,
  handshakeMs: 30_000,
  /** How long a close waits for the server's close frame. */
  closeMs: 5_000,
} as const;

type Listener = (event: { type?: string; data?: unknown; code?: number; reason?: string }) => void;
type EventType = "open" | "message" | "error" | "close";

export interface PenWebSocketOptions {
  /** The one origin this constructor serves (http or https; ws and wss are mapped to it). */
  readonly origin: string;
  readonly openStream: () => Promise<PenStream>;
  readonly clock: Clock;
  readonly random: Random;
}

/** Effect's Socket.WebSocketLike, structurally. */
export interface PenWebSocketLike {
  readonly readyState: number;
  binaryType: string;
  addEventListener(
    type: EventType,
    listener: Listener,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: EventType, listener: Listener): void;
  close(code?: number, reason?: string): void;
  send(data: string | Uint8Array): void;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function parseWsTarget(url: string, origin: string): { host: string; target: string } {
  const bound = /^(https?):\/\/([^/?#@\s]+)\/?$/i.exec(origin.replace(/\/$/, ""));
  const match = /^(wss?|https?):\/\/([^/?#@\s]+)([^#\s]*)$/i.exec(url);
  if (bound === null || match === null)
    throw new PenError("http1/H47", "not a URL this socket serves");
  const secure = (s: string) => s.toLowerCase() === "wss" || s.toLowerCase() === "https";
  if (
    secure(match[1] ?? "") !== secure(bound[1] ?? "") ||
    (match[2] ?? "").toLowerCase() !== (bound[2] ?? "").toLowerCase()
  ) {
    throw new PenError("http1/H47", "a Pen WebSocket serves only " + origin);
  }
  const rest = match[3] ?? "";
  return {
    host: (bound[2] ?? "").toLowerCase(),
    target: rest === "" ? "/" : rest.startsWith("?") ? "/" + rest : rest,
  };
}

class PenWebSocket implements PenWebSocketLike {
  readyState = CONNECTING;
  binaryType = "arraybuffer";
  readonly #options: PenWebSocketOptions;
  readonly #listeners = new Map<EventType, Set<{ listener: Listener; once: boolean }>>();
  #stream: PenStream | undefined;
  #outbound: Array<Uint8Array> = [];
  #outboundBytes = 0;
  #pumping: Promise<void> | undefined;
  #closeSent = false;
  #closeTimer: Timer | undefined;
  #finished = false;

  constructor(url: string, protocol: string | undefined, options: PenWebSocketOptions) {
    this.#options = options;
    const { host, target } = parseWsTarget(url, options.origin);
    void this.#connect(host, target, protocol);
  }

  addEventListener(
    type: EventType,
    listener: Listener,
    options?: { readonly once?: boolean },
  ): void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add({ listener, once: options?.once === true });
  }

  removeEventListener(type: EventType, listener: Listener): void {
    const set = this.#listeners.get(type);
    if (set === undefined) return;
    for (const entry of set) if (entry.listener === listener) set.delete(entry);
  }

  #dispatch(
    type: EventType,
    event: { type: string; data?: unknown; code?: number; reason?: string },
  ): void {
    const set = this.#listeners.get(type);
    if (set === undefined) return;
    for (const entry of Array.from(set)) {
      if (entry.once) set.delete(entry);
      entry.listener(event);
    }
  }

  async #connect(host: string, target: string, protocol: string | undefined): Promise<void> {
    let timer: Timer | undefined;
    try {
      const stream = await this.#options.openStream();
      this.#stream = stream;
      if (this.readyState !== CONNECTING) {
        stream.close(1000);
        return;
      }
      const request = buildUpgradeRequest({
        host,
        target,
        random: this.#options.random,
        ...(protocol === undefined ? {} : { protocol }),
      });
      timer = this.#options.clock.setTimer(PEN_WEBSOCKET_LIMITS.handshakeMs, () =>
        this.#fail(1006, "no 101 within 30 s"),
      );
      await stream.write(request.bytes);
      const parser = new ResponseParser({
        method: "GET",
        upgrade: { key: request.key, ...(protocol === undefined ? {} : { protocol }) },
        bodyCap: 0,
      });
      let upgraded = false;
      while (!upgraded) {
        const chunk = await stream.read();
        const events = chunk === null ? parser.finish() : parser.push(chunk);
        for (const event of events) {
          if (event.type === "head" && event.status !== 101)
            throw new PenError("ws/not-upgraded", "status " + event.status);
          if (event.type === "end") upgraded = event.delimiter === "upgrade";
        }
      }
      timer.cancel();
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.#dispatch("open", { type: "open" });
      try {
        await this.#readLoop(stream, parser.leftover());
      } catch (error) {
        // A protocol violation by the server: send a close frame with its code, then fail (RFC 6455 section 7.1.7).
        const code = error instanceof PenError ? error.closeCode : undefined;
        if (code !== undefined && code !== 1006 && !this.#closeSent) {
          this.#closeSent = true;
          this.#enqueue(encodeFrame(Opcode.Close, closePayload(code), this.#options.random));
        }
        throw error;
      }
    } catch (error) {
      timer?.cancel();
      const code =
        error instanceof PenError && error.closeCode !== undefined ? error.closeCode : 1006;
      this.#fail(code, error instanceof Error ? error.message : "connection failed");
    }
  }

  /** Reads one chunk at a time and hands each message out before the next read: the stream's credit is the backpressure. */
  async #readLoop(stream: PenStream, first: Uint8Array): Promise<void> {
    const decoder = new FrameDecoder();
    let chunk: Uint8Array | null = first;
    for (;;) {
      const events: Array<FrameEvent> = chunk === null ? decoder.finish() : decoder.push(chunk);
      for (const event of events) {
        if (event.type === "message") {
          const data = typeof event.data === "string" ? event.data : event.data;
          this.#dispatch("message", { type: "message", data });
        } else if (event.type === "ping") {
          if (this.readyState === OPEN)
            this.#enqueue(encodeFrame(Opcode.Pong, event.payload, this.#options.random));
        } else {
          if (!this.#closeSent) {
            this.#closeSent = true;
            const echo = event.code === 1005 ? new Uint8Array(0) : closePayload(event.code);
            this.#enqueue(encodeFrame(Opcode.Close, echo, this.#options.random));
          }
          this.#finish(event.code, event.reason);
          return;
        }
      }
      if (this.#finished) return;
      // The stream ended with no close frame: an abnormal closure (RFC 6455 section 7.1.5).
      if (chunk === null)
        throw new PenError("ws/W25", "the stream ended without a close frame", { closeCode: 1006 });
      chunk = await stream.read();
    }
  }

  send(data: string | Uint8Array): void {
    if (this.readyState === CONNECTING) throw new Error("INVALID_STATE_ERR");
    if (this.readyState !== OPEN) return;
    const payload = typeof data === "string" ? utf8Encode(data) : data;
    if (payload.length > WEBSOCKET_LIMITS.message)
      throw new PenError("ws/send-too-large", "a message is at most 16 MiB");
    const opcode = typeof data === "string" ? Opcode.Text : Opcode.Binary;
    this.#enqueue(encodeFrame(opcode, payload, this.#options.random));
  }

  #enqueue(frame: Uint8Array): void {
    const full =
      this.#outbound.length >= PEN_WEBSOCKET_LIMITS.outboundFrames ||
      (this.#outbound.length > 0 &&
        this.#outboundBytes + frame.length > PEN_WEBSOCKET_LIMITS.outboundBytes);
    if (full) {
      this.#dispatch("error", { type: "error" });
      if (!this.#closeSent) {
        this.#closeSent = true;
        this.#outbound = [];
        this.#outboundBytes = 0;
        this.#outbound.push(encodeFrame(Opcode.Close, closePayload(1008), this.#options.random));
        void this.#pump();
      }
      this.#finish(1006, "outbound buffer full");
      return;
    }
    this.#outbound.push(frame);
    this.#outboundBytes += frame.length;
    void this.#pump();
  }

  /** Writes queued frames in order; one pump runs at a time and its promise settles when the queue is empty. */
  #pump(): Promise<void> {
    this.#pumping ??= this.#drain().finally(() => {
      this.#pumping = undefined;
    });
    return this.#pumping;
  }

  async #drain(): Promise<void> {
    try {
      for (;;) {
        const frame = this.#outbound.shift();
        const stream = this.#stream;
        if (frame === undefined || stream === undefined) return;
        this.#outboundBytes -= frame.length;
        for (let at = 0; at < frame.length; at += PEN_WEBSOCKET_LIMITS.writePiece) {
          await stream.write(frame.subarray(at, at + PEN_WEBSOCKET_LIMITS.writePiece));
        }
      }
    } catch {
      this.#fail(1006, "the stream failed");
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= CLOSING) return;
    if (this.readyState === CONNECTING) {
      this.readyState = CLOSING;
      this.#stream?.close(1000);
      this.#finish(1006, "closed before open");
      return;
    }
    this.readyState = CLOSING;
    this.#closeSent = true;
    this.#enqueue(encodeFrame(Opcode.Close, closePayload(code, reason), this.#options.random));
    this.#closeTimer = this.#options.clock.setTimer(PEN_WEBSOCKET_LIMITS.closeMs, () =>
      this.#finish(1006, "no close frame", true),
    );
  }

  #fail(code: number, reason: string): void {
    if (this.#finished) return;
    this.#dispatch("error", { type: "error" });
    this.#finish(code, reason);
  }

  /**
   * Ends the socket. Queued frames (a close echo, or the close frame naming a protocol error) drain for at most
   * the close timeout; an expired close timeout closes the stream at once (4408) and drops what is queued.
   */
  #finish(code: number, reason: string, force = false): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#closeTimer?.cancel();
    this.readyState = CLOSED;
    const stream = this.#stream;
    if (force) {
      this.#outbound = [];
      this.#outboundBytes = 0;
      stream?.close(4408);
    } else {
      const drainLimit = this.#options.clock.setTimer(PEN_WEBSOCKET_LIMITS.closeMs, () =>
        stream?.close(4408),
      );
      void this.#pump().then(() => {
        drainLimit.cancel();
        stream?.end();
        stream?.close(1000);
      });
    }
    this.#dispatch("close", { type: "close", code, reason });
  }
}

/** A Socket.WebSocketConstructor over Pen streams, bound to one origin. Options objects are refused, as on iOS. */
export function makePenWebSocketConstructor(options: PenWebSocketOptions) {
  return (url: string, protocols?: string | ReadonlyArray<string> | object): PenWebSocketLike => {
    if (protocols !== undefined && typeof protocols !== "string" && !Array.isArray(protocols)) {
      throw new TypeError("WebSocket client options are not supported over Pen");
    }
    const list =
      protocols === undefined
        ? []
        : typeof protocols === "string"
          ? [protocols]
          : (protocols as ReadonlyArray<string>);
    if (list.length > 1) throw new TypeError("a Pen WebSocket offers at most one subprotocol");
    return new PenWebSocket(url, list[0], options);
  };
}
