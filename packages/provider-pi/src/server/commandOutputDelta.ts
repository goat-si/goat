import { contentText } from "./piContentText.ts";
import { piRecordField as field, piRecordNumber as number } from "./rpc.ts";

export function commandOutputDelta(cursors: Map<string, number>, id: string, result: unknown) {
  const tail = Buffer.from(contentText(field(result, "content")), "utf8");
  const total = number(field(field(result, "details"), "truncation"), "totalBytes") ?? tail.length;
  const previous = cursors.get(id) ?? 0;
  cursors.set(id, total);
  if (total <= previous) return "";
  let start = Math.max(0, tail.length - (total - previous));
  while (start < tail.length && ((tail[start] ?? 0) & 0xc0) === 0x80) start++;
  return tail.subarray(start).toString("utf8");
}
