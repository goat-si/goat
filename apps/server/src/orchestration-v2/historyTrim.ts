import { ORCHESTRATION_HISTORY_TRIM_FIELD_BYTES } from "@goat/contracts";
import * as Schema from "effect/Schema";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Room kept for the marker, so a trimmed value fits the limit and is never trimmed again. */
const MARKER_ROOM_BYTES = 64;

/**
 * The head and tail of text within maxBytes UTF-8 bytes, joined by a marker that says how much
 * was dropped. The tail is kept because that is where commands report failures and results.
 */
export function trimHistoryText(
  text: string,
  maxBytes: number = ORCHESTRATION_HISTORY_TRIM_FIELD_BYTES,
): string {
  if (text.length <= maxBytes && Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const half = Math.floor((maxBytes - MARKER_ROOM_BYTES) / 2);
  const head = bytes
    .subarray(0, half)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  const tail = bytes
    .subarray(bytes.length - half)
    .toString("utf8")
    .replace(/^\uFFFD/u, "");
  const dropped = bytes.length - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  return `${head}\n… output trimmed, ${Math.max(1, Math.round(dropped / 1024))} KB …\n${tail}`;
}

/**
 * A turn item, or a turn-item event payload, with its bulky fields trimmed: command and
 * dynamic-tool output and reasoning text. Null when nothing needed trimming. Structured tool
 * output is trimmed as its JSON text, which the item schema accepts as output.
 */
export function trimHistoryItem(
  item: Record<string, unknown>,
  maxBytes: number = ORCHESTRATION_HISTORY_TRIM_FIELD_BYTES,
): Record<string, unknown> | null {
  const field =
    item.type === "command_execution" || item.type === "dynamic_tool"
      ? "output"
      : item.type === "reasoning"
        ? "text"
        : undefined;
  if (field === undefined || item[field] === undefined || item[field] === null) return null;
  const value = item[field];
  const text = typeof value === "string" ? value : encodeJson(value);
  if (text === undefined) return null;
  const trimmed = trimHistoryText(text, maxBytes);
  return trimmed === text ? null : { ...item, [field]: trimmed };
}
