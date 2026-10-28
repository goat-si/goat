/** The most UTF-8 bytes one pull request read returns, so a long thread cannot flood a turn. */
export const READ_BUDGET_BYTES = 256 * 1024;

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

/** The leading items that fit in budget bytes, in order, and how many were left out. */
export const fitItems = <A>(items: ReadonlyArray<A>, budget: number) => {
  const kept: Array<A> = [];
  let used = 0;
  for (const item of items) {
    const size = bytesOf(item);
    if (used + size > budget) break;
    kept.push(item);
    used += size;
  }
  return { kept, omitted: items.length - kept.length, used };
};

/** Text cut to at most budget UTF-8 bytes without splitting a character. */
export const clipText = (text: string, budget: number) => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= budget) return { text, truncated: false };
  let end = budget;
  // Back off continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
};
