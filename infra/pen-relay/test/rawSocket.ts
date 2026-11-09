// @effect-diagnostics nodeBuiltinImport:off - Test fixtures drive raw sockets directly.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

/**
 * A minimal RFC 6455 client. Unlike the global WebSocket, `closed` resolves when the close
 * frame arrives, so tests do not wait for wrangler dev's slow TCP teardown after a close.
 */
export class RawWebSocket {
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;
  onBinary: (bytes: Uint8Array) => void = () => {};
  onText: (text: string) => void = () => {};
  private socket: NodeNet.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Array<Buffer> = [];
  private fragmentOpcode = 0;
  private closeSent = false;
  private closeCode: number | null = null;
  private resolveClosed: (code: number) => void = () => {};

  constructor(url: string) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.opened = new Promise((resolve, reject) => {
      const request = NodeHttp.request(url.replace(/^ws/, "http"), {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
            "base64",
          ),
        },
      });
      request.once("upgrade", (_response, socket, head) => {
        this.socket = socket;
        socket.on("data", (chunk: Buffer) => this.receive(chunk));
        socket.once("close", () => this.finish(1006));
        socket.on("error", () => this.finish(1006));
        resolve();
        if (head.length > 0) this.receive(head);
      });
      request.once("response", (response) => {
        reject(new Error(`no upgrade: ${response.statusCode}`));
        this.finish(1006);
      });
      request.once("error", (error) => {
        reject(error);
        this.finish(1006);
      });
      request.end();
    });
    this.opened.catch(() => {});
  }

  get isOpen(): boolean {
    return this.socket !== null && this.closeCode === null && !this.closeSent;
  }

  send(data: Uint8Array | string): void {
    if (!this.socket) {
      void this.opened.then(() => this.send(data));
      return;
    }
    if (typeof data === "string") this.write(0x1, Buffer.from(data));
    else this.write(0x2, data);
  }

  close(code?: number): void {
    if (!this.socket) {
      void this.opened.then(() => this.close(code));
      return;
    }
    if (this.closeSent) return;
    this.closeSent = true;
    this.write(0x8, code === undefined ? new Uint8Array(0) : Uint8Array.of(code >> 8, code & 0xff));
  }

  private write(opcode: number, payload: Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    const length = payload.length;
    const header =
      length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    if (length < 126) header[1] = 0x80 | length;
    else if (length < 65536) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    const mask = crypto.getRandomValues(new Uint8Array(4));
    const masked = Buffer.alloc(length);
    for (let i = 0; i < length; i++) masked[i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
    socket.write(Buffer.concat([header, mask, masked]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0] ?? 0;
      const second = this.buffer[1] ?? 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      this.frame(first & 0x80, first & 0x0f, payload);
    }
  }

  private frame(fin: number, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      if (!this.closeSent) {
        this.closeSent = true;
        this.write(0x8, payload.length >= 2 ? payload.subarray(0, 2) : new Uint8Array(0));
      }
      this.finish(code);
      // Close the connection fully once the reply is flushed; a half-close leaves wrangler dev
      // holding the session for seconds before the Worker hears about it.
      const socket = this.socket;
      socket?.end(() => socket.destroy());
      return;
    }
    if (opcode === 0x9) return this.write(0xa, payload);
    if (opcode === 0xa) return;
    if (opcode !== 0x0) this.fragmentOpcode = opcode;
    this.fragments.push(Buffer.from(payload));
    if (!fin) return;
    const message = Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOpcode === 0x1) this.onText(message.toString("utf8"));
    else this.onBinary(new Uint8Array(message));
  }

  private finish(code: number): void {
    if (this.closeCode !== null) return;
    this.closeCode = code;
    this.resolveClosed(code);
  }
}
