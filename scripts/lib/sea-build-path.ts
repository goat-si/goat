/**
 * Node's single-executable blob records the entry script's absolute build path
 * (tsdown passes it as the SEA `main`), which would publish the build machine's
 * checkout location. Replace every occurrence of the checkout root with a neutral
 * path of the same byte length so the blob layout stays valid.
 */
export function neutralizeBuildRoot(bytes: Uint8Array, root: string): Uint8Array {
  const encoder = new TextEncoder();
  const needle = encoder.encode(root.replace(/[\\/]+$/, ""));
  if (needle.length < 2) return bytes;
  const neutral = encoder.encode(`/goat-build`.padEnd(needle.length, "_").slice(0, needle.length));
  const out = Uint8Array.from(bytes);
  for (let index = 0; index <= out.length - needle.length; index += 1) {
    let match = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (out[index + offset] !== needle[offset]) {
        match = false;
        break;
      }
    }
    if (match) {
      out.set(neutral, index);
      index += needle.length - 1;
    }
  }
  return out;
}
