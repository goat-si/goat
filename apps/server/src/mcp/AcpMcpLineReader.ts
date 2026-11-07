const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

// MCP uses LF framing; Unicode line separators are valid JSON string content.
export async function* readAcpMcpLines(
  input: NodeJS.ReadableStream,
): AsyncGenerator<string | null> {
  let buffer = Buffer.alloc(0);
  let length = 0;
  let oversized = false;
  for await (const chunk of input as AsyncIterable<Uint8Array | string>) {
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      const size = end - start;
      if (!oversized && size > MAX_MESSAGE_BYTES - length) oversized = true;
      if (!oversized && size > 0) {
        const needed = length + size;
        if (needed > buffer.length) {
          const next = Buffer.allocUnsafe(
            Math.min(MAX_MESSAGE_BYTES, Math.max(4096, needed, buffer.length * 2)),
          );
          buffer.copy(next, 0, 0, length);
          buffer = next;
        }
        bytes.copy(buffer, length, start, end);
        length = needed;
      }
      if (newline < 0) break;
      yield oversized ? null : buffer.toString("utf8", 0, length).replace(/\r$/, "");
      length = 0;
      oversized = false;
      start = newline + 1;
    }
  }
  if (oversized) yield null;
  else if (length > 0) yield buffer.toString("utf8", 0, length).replace(/\r$/, "");
}
