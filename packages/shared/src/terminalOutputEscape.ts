export const ESC = "\u001b";

export const STRING_SEQUENCE_INTRODUCERS = new Set(["]", "P", "X", "_", "^"]);

/** Length of a complete escape sequence starting at `index` (an ESC), or -1 if unfinished. */
export function escapeLength(input: string, index: number): number {
  const next = input[index + 1];
  if (next === undefined) return -1;
  // A second ESC restarts the sequence.
  if (next === ESC) return 1;
  if (next === "[") {
    for (let cursor = index + 2; cursor < input.length; cursor += 1) {
      const code = input.charCodeAt(cursor);
      if (code === 0x1b) return cursor - index;
      if (code === 0x18 || code === 0x1a) return cursor - index + 1;
      if (code >= 0x40 && code <= 0x7e) return cursor - index + 1;
      if (code >= 0x80) {
        if (code >= 0xd800 && code <= 0xdbff) {
          if (cursor + 1 >= input.length) return -1;
          const low = input.charCodeAt(cursor + 1);
          if (low >= 0xdc00 && low <= 0xdfff) return cursor - index + 2;
        }
        return cursor - index + 1;
      }
    }
    return -1;
  }
  if (STRING_SEQUENCE_INTRODUCERS.has(next)) {
    // BEL/ST ends string sequences; also stop at newlines so stray binary introducers cannot hide later output.
    for (let cursor = index + 2; cursor < input.length; cursor += 1) {
      if (input[cursor] === "\u0007") return cursor - index + 1;
      if (input[cursor] === "\u0018" || input[cursor] === "\u001a") return cursor - index + 1;
      if (input[cursor] === "\n") return cursor - index;
      // Like xterm.js, an ESC that does not start ST ends the string and begins the next sequence.
      if (input[cursor] === ESC) {
        if (cursor + 1 >= input.length) return -1;
        return input[cursor + 1] === "\\" ? cursor - index + 2 : cursor - index;
      }
    }
    return -1;
  }
  // ECMA-35: any intermediate bytes (0x20-0x2F, e.g. charset designations, DECALN) precede one final byte.
  let cursor = index + 1;
  while (
    cursor < input.length &&
    input.charCodeAt(cursor) >= 0x20 &&
    input.charCodeAt(cursor) <= 0x2f
  ) {
    cursor += 1;
  }
  if (cursor >= input.length) return -1;
  // After intermediates, a control or ESC is not a final byte; end before it so it is still processed.
  const final = input.charCodeAt(cursor);
  if (cursor > index + 1 && (final < 0x30 || final > 0x7e)) return cursor - index;
  if (final >= 0xd800 && final <= 0xdbff) {
    if (cursor + 1 >= input.length) return -1;
    const low = input.charCodeAt(cursor + 1);
    if (low >= 0xdc00 && low <= 0xdfff) return cursor - index + 2;
  }
  return cursor - index + 1;
}
