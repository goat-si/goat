// A Pen stream over a confirmed session (CONTRACT "Streams", tcp framing): DATA, FIN and CREDIT with the 512 KiB
// window. Inbound bytes live in one fixed 512 KiB ring, so memory does not depend on record sizes.
import { PenError } from "./errors.ts";
import type { SecureSession } from "./race.ts";

export const STREAM_LIMITS = {
  window: 512 * 1024,
  maxData: 65_518,
  creditEvery: 64 * 1024,
  /** The most one write() takes; callers split larger bodies. */
  maxWrite: 1024 * 1024,
  /** The most one read() returns. */
  readChunk: 64 * 1024,
} as const;

const TYPE_DATA = 0x00;
const TYPE_FIN = 0x01;
const TYPE_CREDIT = 0x02;

export interface PenStreamStats {
  /** Bytes received and not yet read. */
  readonly buffered: number;
  /** The ring's allocated size: 0 before the first DATA, then exactly the window. */
  readonly capacity: number;
  /** DATA received and not yet credited back. */
  readonly uncredited: number;
  /** DATA sent and not yet credited by the peer. */
  readonly inflight: number;
}

export interface PenStream {
  /** Sends bytes (at most 1 MiB per call, one call at a time), waiting for the peer's credit and the socket. */
  write(bytes: Uint8Array): Promise<void>;
  /** Sends FIN once: this side writes no more. */
  end(): void;
  /** Up to 64 KiB of received bytes; null once the peer's FIN is reached. */
  read(): Promise<Uint8Array | null>;
  close(code: number): void;
  readonly closed: Promise<number>;
  stats(): PenStreamStats;
}

class Ring {
  #buffer: Uint8Array | undefined;
  #head = 0;
  size = 0;

  get capacity(): number {
    return this.#buffer?.length ?? 0;
  }

  push(bytes: Uint8Array): void {
    this.#buffer ??= new Uint8Array(STREAM_LIMITS.window);
    const buffer = this.#buffer;
    let tail = (this.#head + this.size) % buffer.length;
    const first = Math.min(bytes.length, buffer.length - tail);
    buffer.set(bytes.subarray(0, first), tail);
    buffer.set(bytes.subarray(first), 0);
    tail = (tail + bytes.length) % buffer.length;
    this.size += bytes.length;
  }

  take(max: number): Uint8Array {
    const buffer = this.#buffer;
    const length = Math.min(max, this.size);
    const out = new Uint8Array(length);
    if (buffer === undefined) return out;
    const first = Math.min(length, buffer.length - this.#head);
    out.set(buffer.subarray(this.#head, this.#head + first));
    out.set(buffer.subarray(0, length - first), first);
    this.#head = (this.#head + length) % buffer.length;
    this.size -= length;
    return out;
  }
}

const u32le = (n: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
};

export function openStream(session: SecureSession): PenStream {
  return new Stream(session);
}

class Stream implements PenStream {
  readonly closed: Promise<number>;
  readonly session: SecureSession;
  #ring = new Ring();
  #inflight = 0;
  #uncredited = 0;
  #consumed = 0;
  #peerFin = false;
  #sentFin = false;
  #eofRead = false;
  #closeCode: number | undefined;
  #writing = false;
  #finAfterWrite = false;
  #readers: Array<() => void> = [];
  #creditWaiters: Array<() => void> = [];

  constructor(session: SecureSession) {
    this.session = session;
    this.closed = session.closed;
    session.onClose((code) => {
      this.#closeCode = code;
      this.#wake();
    });
    // The close observer comes first, so a held record that closes the session stops the ones after it.
    session.onRecord((record) => this.#onRecord(record));
  }

  stats(): PenStreamStats {
    return {
      buffered: this.#ring.size,
      capacity: this.#ring.capacity,
      uncredited: this.#uncredited,
      inflight: this.#inflight,
    };
  }

  #onRecord(record: Uint8Array): void {
    if (this.#closeCode !== undefined) return;
    const type = record[0];
    if (type === TYPE_DATA) {
      if (this.#peerFin) return this.close(4400);
      const length = record.length - 1;
      if (length === 0) return;
      if (this.#uncredited + length > STREAM_LIMITS.window) return this.close(4408);
      this.#uncredited += length;
      this.#ring.push(record.subarray(1));
      this.#wake();
      return;
    }
    if (type === TYPE_FIN) {
      if (record.length !== 1 || this.#peerFin) return this.close(4400);
      this.#peerFin = true;
      this.#wake();
      return;
    }
    if (type === TYPE_CREDIT) {
      if (record.length !== 5) return this.close(4400);
      const credit = new DataView(record.buffer, record.byteOffset + 1, 4).getUint32(0, true);
      if (credit > this.#inflight) return this.close(4400);
      this.#inflight -= credit;
      this.#wake();
      return;
    }
    // An empty record or an unknown type.
    this.close(4400);
  }

  #wake(): void {
    for (const wake of this.#readers.splice(0)) wake();
    for (const wake of this.#creditWaiters.splice(0)) wake();
  }

  #sendCredit(): void {
    const amount = this.#consumed;
    try {
      this.session.send(Uint8Array.of(TYPE_CREDIT, ...u32le(amount)));
    } catch {
      // Not sent, so not counted. A refused send has ended the link; a session that cannot seal or send at all is
      // closed 4400, since a sealed record that never left breaks the peer's nonce sequence.
      if (this.#closeCode === undefined) this.close(4400);
      return;
    }
    this.#consumed = 0;
    this.#uncredited -= amount;
  }

  async read(): Promise<Uint8Array | null> {
    for (;;) {
      if (this.#ring.size > 0) {
        const chunk = this.#ring.take(STREAM_LIMITS.readChunk);
        this.#consumed += chunk.length;
        if (this.#consumed >= STREAM_LIMITS.creditEvery && this.#closeCode === undefined)
          this.#sendCredit();
        return chunk;
      }
      if (this.#peerFin) {
        if (this.#consumed > 0 && this.#closeCode === undefined) this.#sendCredit();
        this.#eofRead = true;
        this.#maybeFinish();
        return null;
      }
      if (this.#closeCode !== undefined) throw this.#closedError();
      await new Promise<void>((resolve) => this.#readers.push(resolve));
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (bytes.length > STREAM_LIMITS.maxWrite) {
      throw new PenError("write-too-large", "one write takes at most 1 MiB");
    }
    if (this.#writing) throw new PenError("write-pending", "a write is already in progress");
    if (this.#sentFin) throw new PenError("write-after-end", "the stream was ended");
    this.#writing = true;
    try {
      for (let offset = 0; offset < bytes.length; offset += STREAM_LIMITS.maxData) {
        const chunk = bytes.subarray(offset, offset + STREAM_LIMITS.maxData);
        while (this.#inflight + chunk.length > STREAM_LIMITS.window) {
          if (this.#closeCode !== undefined) throw this.#closedError();
          await new Promise<void>((resolve) => this.#creditWaiters.push(resolve));
        }
        if (this.#closeCode !== undefined) throw this.#closedError();
        await this.session.writable();
        const record = new Uint8Array(chunk.length + 1);
        record[0] = TYPE_DATA;
        record.set(chunk, 1);
        this.session.send(record);
        this.#inflight += chunk.length;
      }
    } finally {
      this.#writing = false;
      // An end() that arrived during this write sends its FIN now, after the write's last DATA.
      if (this.#finAfterWrite) {
        this.#finAfterWrite = false;
        this.#sendFin();
      }
    }
  }

  end(): void {
    if (this.#sentFin || this.#closeCode !== undefined) return;
    if (this.#writing) {
      this.#finAfterWrite = true;
      return;
    }
    this.#sendFin();
  }

  #sendFin(): void {
    if (this.#sentFin || this.#closeCode !== undefined) return;
    this.#sentFin = true;
    this.session.send(Uint8Array.of(TYPE_FIN));
    this.#maybeFinish();
  }

  /** Both FINs sent and the reader reached the end: the session ends normally. */
  #maybeFinish(): void {
    if (this.#sentFin && this.#peerFin && this.#eofRead && this.#closeCode === undefined)
      this.close(1000);
  }

  close(code: number): void {
    if (this.#closeCode !== undefined) return;
    this.session.close(code);
  }

  #closedError(): PenError {
    return new PenError("stream-closed", "the stream closed " + this.#closeCode, {
      closeCode: this.#closeCode,
    });
  }
}
