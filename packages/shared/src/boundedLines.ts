// @effect-diagnostics nodeBuiltinImport:off - frames the Node Readable that child process and socket owners already hold.
import * as NodeBuffer from "node:buffer";
import * as NodeEvents from "node:events";
import type * as NodeStream from "node:stream";

export class BoundedLines extends NodeEvents.EventEmitter {
  private readonly input: NodeStream.Readable;
  private readonly maxBytes: number;
  private chunks: NodeBuffer.Buffer[] = [];
  private bytes = 0;
  private closed = false;

  constructor(input: NodeStream.Readable, maxBytes: number) {
    super();
    this.input = input;
    this.maxBytes = maxBytes;
    input.on("data", this.onData);
    input.once("end", this.onEnd);
  }

  private readonly onData = (chunk: NodeBuffer.Buffer) => {
    let offset = 0;
    while (!this.closed && offset < chunk.byteLength) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.byteLength : newline;
      const part = chunk.subarray(offset, end);
      const size = this.bytes + part.byteLength;
      const last = part.byteLength > 0 ? part.at(-1) : this.chunks.at(-1)?.at(-1);
      // CRLF may put the terminal CR one byte past an exact payload limit.
      if (size > this.maxBytes && !(size === this.maxBytes + 1 && last === 13)) {
        this.close();
        this.emit("limit");
        return;
      }
      if (part.byteLength > 0) this.chunks.push(NodeBuffer.Buffer.from(part));
      this.bytes = size;
      if (newline < 0) return;
      this.flush();
      offset = newline + 1;
    }
  };

  private flush() {
    const line = NodeBuffer.Buffer.concat(this.chunks, this.bytes);
    this.chunks = [];
    this.bytes = 0;
    const end = line.at(-1) === 13 ? line.byteLength - 1 : line.byteLength;
    this.emit("line", line.subarray(0, end).toString("utf8"));
  }

  private readonly onEnd = () => {
    if (!this.closed && this.bytes > 0) this.flush();
    this.close();
  };

  close() {
    if (this.closed) return;
    this.closed = true;
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.chunks = [];
    this.bytes = 0;
    this.input.resume();
  }
}
