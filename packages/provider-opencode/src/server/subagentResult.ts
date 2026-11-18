export const TRACKING_LOST = "Tracking lost. Outcome unknown.";

const MAX_RESULT_BYTES = 4096;
const ELLIPSIS = "…";

export function subagentResultPreview(result: string): string {
  // Copy a bounded prefix so the preview cannot keep the original string's backing store alive.
  const bytes = Buffer.from(result.slice(0, MAX_RESULT_BYTES + 1));
  if (bytes.length <= MAX_RESULT_BYTES) return bytes.toString();
  let end = MAX_RESULT_BYTES - Buffer.byteLength(ELLIPSIS);
  while (((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.toString("utf8", 0, end) + ELLIPSIS;
}
