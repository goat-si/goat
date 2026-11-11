// RFC 6455 over a Pen stream, client side (design 10.2): the opening handshake, masked frames out, and an incremental
// frame decoder that holds at most one message and refuses every ambiguous or oversized form before allocating.
import { ByteBuffer, concatBytes, toBase64, utf8Encode } from "./bytes.ts";
import { PenError } from "./errors.ts";
import { type HeaderList, serializeRequest } from "./http1.ts";
import { type Random, takeRandom } from "./runtime.ts";
import { Utf8Decoder } from "./utf8.ts";

export const WEBSOCKET_LIMITS = {
  message: 16 * 1024 * 1024,
  fragments: 1024,
  control: 125,
  closeReason: 123,
} as const;

export const Opcode = { Continuation: 0, Text: 1, Binary: 2, Close: 8, Ping: 9, Pong: 10 } as const;

export type FrameEvent =
  | { readonly type: "message"; readonly data: string | Uint8Array }
  | { readonly type: "ping"; readonly payload: Uint8Array }
  | { readonly type: "close"; readonly code: number; readonly reason: string };

const fail = (rule: string, closeCode: number, message: string) =>
  new PenError("ws/" + rule, message, { closeCode });

/** A close code a peer may send (RFC 6455 section 7.4, design 10.2). */
export function validCloseCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1011) ||
    (code >= 3000 && code <= 4999)
  );
}

export interface UpgradeRequest {
  readonly bytes: Uint8Array;
  readonly key: string;
}

/** The opening handshake: version 13, a 16-byte CSPRNG key, no extension, at most one subprotocol. */
export function buildUpgradeRequest(options: {
  readonly host: string;
  readonly target: string;
  readonly headers?: HeaderList;
  readonly protocol?: string;
  readonly random: Random;
}): UpgradeRequest {
  const key = toBase64(takeRandom(options.random, 16));
  const upgrade: Array<readonly [string, string]> = [
    ["Upgrade", "websocket"],
    ["Connection", "Upgrade"],
    ["Sec-WebSocket-Key", key],
    ["Sec-WebSocket-Version", "13"],
  ];
  if (options.protocol !== undefined) upgrade.push(["Sec-WebSocket-Protocol", options.protocol]);
  const bytes = serializeRequest(
    { method: "GET", target: options.target, host: options.host, headers: options.headers ?? [] },
    upgrade,
  );
  return { bytes, key };
}

/** One masked frame with a fresh CSPRNG mask; a Random failure throws before any byte exists. */
export function encodeFrame(
  opcode: number,
  payload: Uint8Array,
  random: Random,
  fin = true,
): Uint8Array {
  const mask = takeRandom(random, 4);
  const length = payload.length;
  const header =
    length <= 125
      ? Uint8Array.of(0, 0x80 | length)
      : length <= 0xffff
        ? Uint8Array.of(0, 0x80 | 126, length >> 8, length & 255)
        : (() => {
            const out = new Uint8Array(10);
            out[1] = 0x80 | 127;
            new DataView(out.buffer).setUint32(2, Math.floor(length / 2 ** 32));
            new DataView(out.buffer).setUint32(6, length >>> 0);
            return out;
          })();
  header[0] = (fin ? 0x80 : 0) | opcode;
  const out = concatBytes(header, mask, payload);
  const start = header.length + 4;
  for (let i = 0; i < length; i++) out[start + i] = (out[start + i] ?? 0) ^ (mask[i & 3] ?? 0);
  return out;
}

export function closePayload(code: number, reason = ""): Uint8Array {
  const text = utf8Encode(reason);
  if (text.length > WEBSOCKET_LIMITS.closeReason)
    throw new PenError("ws/close-reason", "close reason over 123 bytes");
  return concatBytes(Uint8Array.of(code >> 8, code & 255), text);
}

type Stage = "b0" | "b1" | "len16" | "len64" | "payload";

/** Incremental decoder of server frames. Checks run as each header byte arrives, so every split agrees. */
export class FrameDecoder {
  #error: PenError | undefined;
  #closed = false;
  #stage: Stage = "b0";
  #fin = false;
  #opcode = 0;
  #lengthBytes: Array<number> = [];
  #remaining = 0;
  #control = new ByteBuffer(WEBSOCKET_LIMITS.control);
  // The message being assembled across fragments.
  #messageOpcode: number | undefined;
  #fragments = 0;
  #messageBytes = 0;
  #message = new ByteBuffer(WEBSOCKET_LIMITS.message);
  #text: Utf8Decoder | undefined;

  /** The largest message buffer this decoder has allocated. */
  peakCapacity(): number {
    return this.#message.peakCapacity;
  }

  push(bytes: Uint8Array): Array<FrameEvent> {
    if (this.#error !== undefined) throw this.#error;
    try {
      return this.#push(bytes);
    } catch (error) {
      // Any failure is final, and only PenError leaves the decoder.
      this.#error =
        error instanceof PenError ? error : fail("internal", 1011, "the decoder failed");
      throw this.#error;
    }
  }

  /** The stream ended: inside a frame or a fragmented message that is an abnormal close (1006). */
  finish(): Array<FrameEvent> {
    if (this.#error !== undefined) throw this.#error;
    if (this.#stage !== "b0" || this.#messageOpcode !== undefined) {
      this.#error = fail("W25", 1006, "the stream ended inside a frame");
      throw this.#error;
    }
    return [];
  }

  #push(bytes: Uint8Array): Array<FrameEvent> {
    const events: Array<FrameEvent> = [];
    let at = 0;
    while (at < bytes.length) {
      if (this.#closed) throw fail("W19", 1002, "a frame after the close");
      const byte = bytes[at] ?? 0;
      switch (this.#stage) {
        case "b0":
          this.#firstByte(byte);
          at += 1;
          break;
        case "b1":
          this.#secondByte(byte, events);
          at += 1;
          break;
        case "len16":
        case "len64":
          this.#lengthBytes.push(byte);
          at += 1;
          this.#lengthByte(events);
          break;
        case "payload": {
          const take = Math.min(this.#remaining, bytes.length - at);
          const piece = bytes.subarray(at, at + take);
          at += take;
          this.#remaining -= take;
          this.#acceptPayload(piece);
          if (this.#remaining === 0) this.#endFrame(events);
          break;
        }
      }
    }
    return events;
  }

  #firstByte(byte: number): void {
    if ((byte & 0x70) !== 0) throw fail("W04", 1002, "a reserved bit is set");
    const opcode = byte & 0x0f;
    if (opcode > 2 && opcode < 8) throw fail("W05", 1002, "unknown opcode");
    if (opcode > 10) throw fail("W05", 1002, "unknown opcode");
    this.#fin = (byte & 0x80) !== 0;
    this.#opcode = opcode;
    if (opcode >= 8) {
      if (!this.#fin) throw fail("W09", 1002, "a control frame is fragmented");
    } else if (opcode === Opcode.Continuation) {
      if (this.#messageOpcode === undefined)
        throw fail("W11", 1002, "a continuation with no message");
    } else if (this.#messageOpcode !== undefined) {
      throw fail("W12", 1002, "a new message inside a fragmented one");
    }
    this.#stage = "b1";
  }

  #secondByte(byte: number, events: Array<FrameEvent>): void {
    if ((byte & 0x80) !== 0) throw fail("W03", 1002, "a server frame is masked");
    const length = byte & 0x7f;
    if (this.#opcode >= 8 && length > WEBSOCKET_LIMITS.control) {
      throw fail("W08", 1002, "a control payload over 125 bytes");
    }
    this.#lengthBytes = [];
    if (length === 126) this.#stage = "len16";
    else if (length === 127) this.#stage = "len64";
    else this.#startPayload(length, events);
  }

  #lengthByte(events: Array<FrameEvent>): void {
    const bytes = this.#lengthBytes;
    if (this.#stage === "len64" && bytes.length === 1 && ((bytes[0] ?? 0) & 0x80) !== 0) {
      throw fail("W07", 1002, "a 64-bit length with the high bit set");
    }
    const need = this.#stage === "len16" ? 2 : 8;
    if (bytes.length < need) return;
    let length = 0;
    for (const byte of bytes) length = length * 256 + byte;
    if (this.#stage === "len16" ? length <= 125 : length <= 0xffff) {
      throw fail("W06", 1002, "a length not in its shortest form");
    }
    this.#startPayload(length, events);
  }

  /** Size and fragment limits are checked here, from the declared length, before any payload is held. */
  #startPayload(length: number, events: Array<FrameEvent>): void {
    if (this.#opcode < 8) {
      const fragments = this.#messageOpcode === undefined ? 1 : this.#fragments + 1;
      if (fragments > WEBSOCKET_LIMITS.fragments)
        throw fail("W13", 1009, "more than 1,024 fragments");
      const total = (this.#messageOpcode === undefined ? 0 : this.#messageBytes) + length;
      if (total > WEBSOCKET_LIMITS.message) throw fail("W14", 1009, "a message over 16 MiB");
      if (this.#messageOpcode === undefined) {
        this.#messageOpcode = this.#opcode;
        this.#fragments = 0;
        this.#messageBytes = 0;
        this.#message = new ByteBuffer(WEBSOCKET_LIMITS.message);
        this.#text = this.#opcode === Opcode.Text ? new Utf8Decoder() : undefined;
      }
      this.#fragments += 1;
      this.#messageBytes += length;
      // Binary payload goes into one buffer: sized exactly for the final frame, doubling before it.
      if (this.#text === undefined) this.#message.reserve(this.#messageBytes, this.#fin);
    }
    this.#control = new ByteBuffer(WEBSOCKET_LIMITS.control);
    this.#remaining = length;
    this.#stage = "payload";
    if (length === 0) this.#endFrame(events);
  }

  #acceptPayload(piece: Uint8Array): void {
    if (this.#opcode >= 8) {
      this.#control.append(piece);
      return;
    }
    if (this.#text !== undefined) {
      if (!this.#text.push(piece)) throw fail("W15", 1007, "text is not UTF-8");
    } else {
      this.#message.append(piece);
    }
  }

  #endFrame(events: Array<FrameEvent>): void {
    this.#stage = "b0";
    if (this.#opcode >= 8) {
      const payload = this.#control.take();
      if (this.#opcode === Opcode.Ping) events.push({ type: "ping", payload });
      else if (this.#opcode === Opcode.Close) events.push(this.#close(payload));
      // A pong is never solicited by this client, so it is ignored.
      return;
    }
    if (!this.#fin) return;
    const text = this.#text;
    const data = text === undefined ? this.#message.take() : text.finish() ? text.take() : null;
    if (data === null) throw fail("W15", 1007, "text ends inside a code point");
    this.#messageOpcode = undefined;
    this.#text = undefined;
    events.push({ type: "message", data });
  }

  #close(payload: Uint8Array): FrameEvent {
    this.#closed = true;
    if (payload.length === 0) return { type: "close", code: 1005, reason: "" };
    if (payload.length === 1) throw fail("W17", 1002, "a one-byte close payload");
    const code = ((payload[0] ?? 0) << 8) | (payload[1] ?? 0);
    if (!validCloseCode(code)) throw fail("W16", 1002, "an invalid close code");
    const decoder = new Utf8Decoder();
    if (!decoder.push(payload.subarray(2)) || !decoder.finish())
      throw fail("W18", 1007, "close reason is not UTF-8");
    return { type: "close", code, reason: decoder.take() };
  }
}
