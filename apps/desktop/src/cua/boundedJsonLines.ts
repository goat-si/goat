// @effect-diagnostics nodeBuiltinImport:off -- Bounds native stdio frames before decoding them.
import type { Readable } from "node:stream";

/** Bounds bytes even when a peer never sends a newline; preserves split UTF-8 sequences. */
export function readBoundedLines(
  input: Readable,
  limit: number,
  line: (text: string) => void,
  fail: (error: Error) => void,
) {
  let buffer = Buffer.alloc(Math.min(8192, limit));
  let size = 0;
  const data = (chunk: Buffer) => {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const required = size + end - offset;
      if (required > limit) {
        fail(new Error("Stdio line exceeds the byte limit."));
        return;
      }
      if (required > buffer.length) {
        const grown = Buffer.alloc(Math.min(limit, Math.max(required, buffer.length * 2)));
        buffer.copy(grown, 0, 0, size);
        buffer = grown;
      }
      chunk.copy(buffer, size, offset, end);
      size = required;
      if (newline === -1) return;
      const text = buffer.toString("utf8", 0, size);
      size = 0;
      try {
        if (text.trim()) line(text);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      offset = end + 1;
    }
  };
  input.on("data", data);
  return () => {
    input.off("data", data);
    buffer = Buffer.alloc(0);
    size = 0;
  };
}
