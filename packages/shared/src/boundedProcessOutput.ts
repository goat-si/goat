import * as NodeBuffer from "node:buffer";

export function makeByteTail(limit: number) {
  let retained = NodeBuffer.Buffer.alloc(0);
  let truncated = false;
  return {
    append(chunk: Uint8Array) {
      if (retained.byteLength + chunk.byteLength > limit) truncated = true;
      const incoming = chunk.subarray(Math.max(0, chunk.byteLength - limit));
      const keep = Math.max(0, limit - incoming.byteLength);
      retained = NodeBuffer.Buffer.concat([
        retained.subarray(Math.max(0, retained.byteLength - keep)),
        incoming,
      ]);
    },
    result() {
      // A byte tail can begin inside a UTF-8 character; omit its continuation bytes.
      const start = retained.findIndex((byte) => (byte & 0xc0) !== 0x80);
      return {
        text: retained.subarray(start < 0 ? retained.byteLength : start).toString("utf8"),
        bytes: retained.byteLength,
        truncated,
      };
    },
  };
}
