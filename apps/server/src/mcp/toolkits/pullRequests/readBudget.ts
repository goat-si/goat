/** The most UTF-8 bytes one pull request read returns, so a long thread cannot flood a turn. */
export const READ_BUDGET_BYTES = 256 * 1024;
const FIELD_BYTES = 1024;
const FIELD_ITEMS = 20;
// Kept whole so a clipped row still names what a follow-up read needs.
const IDENTIFIER_KEYS = new Set([
  "id",
  "url",
  "host",
  "repository",
  "projectId",
  "headBranch",
  "baseBranch",
  "login",
  "oid",
]);

export const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

/** The leading items that fit in budget bytes, separators included, and how many were left out. */
export const fitItems = <A>(items: ReadonlyArray<A>, budget: number) => {
  const kept: Array<A> = [];
  let used = 0;
  for (const item of items) {
    const size = bytesOf(item) + 1;
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

/** Text cut so its JSON string body, escapes included, is at most budget bytes. */
export const clipJsonText = (text: string, budget: number) => {
  if (bytesOf(text) - 2 <= budget) return { text, truncated: false };
  let used = 0;
  let end = 0;
  for (const char of text) {
    const size = bytesOf(char) - 2;
    if (used + size > budget) break;
    used += size;
    end += char.length;
  }
  return { text: text.slice(0, end), truncated: true };
};

const clipValue = (value: unknown, clip: { clipped: boolean }, key?: string): unknown => {
  if (typeof value === "string") {
    if (key !== undefined && IDENTIFIER_KEYS.has(key)) return value;
    const cut = clipJsonText(value, FIELD_BYTES);
    if (!cut.truncated) return value;
    clip.clipped = true;
    // Contract strings are trimmed, so a cut must not leave trailing space.
    return cut.text.trimEnd();
  }
  if (Array.isArray(value)) {
    if (value.length > FIELD_ITEMS) clip.clipped = true;
    return value.slice(0, FIELD_ITEMS).map((item) => clipValue(item, clip));
  }
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, field]) => [name, clipValue(field, clip, name)]),
    );
  return value;
};

/** value with text cut to 1 KiB of JSON and lists to 20 items, identifiers whole, so one record stays small. */
export const clipFields = <A>(value: A) => {
  const clip = { clipped: false };
  const result = clipValue(value, clip) as A;
  return { value: result, clipped: clip.clipped };
};
