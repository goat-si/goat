/** Drops the whole copy at the byte cap; the caller may keep forwarding the original stream. */
export const makeSnapshotBuffer = (limit: number) => {
  let buffer = new Uint8Array(0);
  let bytes = 0;
  let oversized = false;
  return {
    append: (chunk: Uint8Array) => {
      if (oversized) return false;
      const nextBytes = bytes + chunk.byteLength;
      if (nextBytes > limit) {
        oversized = true;
        buffer = new Uint8Array(0);
        return false;
      }
      // One growing buffer bounds allocation even when a node sends millions of tiny chunks.
      if (nextBytes > buffer.byteLength) {
        const grown = new Uint8Array(
          Math.min(limit, Math.max(nextBytes, buffer.byteLength * 2, 4096)),
        );
        grown.set(buffer.subarray(0, bytes));
        buffer = grown;
      }
      buffer.set(chunk, bytes);
      bytes = nextBytes;
      return true;
    },
    body: () => (oversized ? undefined : new TextDecoder().decode(buffer.subarray(0, bytes))),
  };
};
