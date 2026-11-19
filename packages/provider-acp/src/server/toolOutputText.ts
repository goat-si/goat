import { unknownRecord } from "./clientPolicy.ts";

function decodeByteText(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((entry) => typeof entry === "number" && Number.isInteger(entry))) {
    return undefined;
  }
  try {
    const text = new TextDecoder().decode(Uint8Array.from(value as number[]));
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

export function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const fromBytes = decodeByteText(value);
  if (fromBytes !== undefined) {
    return fromBytes;
  }
  if (Array.isArray(value)) {
    const parts = value.flatMap((entry) => {
      const text = textFromUnknown(entry);
      return text === undefined || text.length === 0 ? [] : [text];
    });
    return parts.length === 0 ? undefined : parts.join("\n");
  }
  const record = unknownRecord(value);
  if (record === undefined) {
    return undefined;
  }
  for (const key of [
    "output_for_prompt",
    "stdout",
    "stderr",
    "output",
    "combinedOutput",
    "combined_output",
    "content",
    "text",
    "message",
  ]) {
    const direct = record[key];
    if (typeof direct === "string" && direct.length > 0) {
      return direct;
    }
    const decoded = decodeByteText(direct);
    if (decoded !== undefined) {
      return decoded;
    }
    const text = textFromUnknown(direct);
    if (text !== undefined && text.length > 0) {
      return text;
    }
  }
  const result = unknownRecord(record.Result) ?? unknownRecord(record.result);
  if (result !== undefined) {
    return textFromUnknown(result);
  }
  return undefined;
}

/** Appends text to an ACP tool content list, extending its last text block when it has one. */
export function appendToolContentText(content: unknown, text: string): unknown[] {
  const next: unknown[] = Array.isArray(content) ? [...content] : [];
  const last = unknownRecord(next.at(-1));
  const lastContent = unknownRecord(last?.content);
  if (
    last?.type === "content" &&
    lastContent?.type === "text" &&
    typeof lastContent.text === "string"
  ) {
    next[next.length - 1] = {
      ...last,
      content: { ...lastContent, text: `${lastContent.text}${text}` },
    };
  } else {
    next.push({ type: "content", content: { type: "text", text } });
  }
  return next;
}

export const TOOL_CALL_CONTENT_MAX_CHARS = 8_000;
export const TOOL_CALL_CONTENT_TRUNCATION_MARKER = "[Earlier output truncated]\n\n";

/** The tail to keep, or undefined when the text fits or an adapter already bounded it. */
export function retainedToolCallOutputTail(text: string): string | undefined {
  if (
    text.length <= TOOL_CALL_CONTENT_MAX_CHARS ||
    (text.startsWith(TOOL_CALL_CONTENT_TRUNCATION_MARKER) &&
      text.length <= TOOL_CALL_CONTENT_MAX_CHARS + TOOL_CALL_CONTENT_TRUNCATION_MARKER.length)
  ) {
    return undefined;
  }
  // A tail starting inside a surrogate pair is invalid Unicode.
  return text.slice(-TOOL_CALL_CONTENT_MAX_CHARS).replace(/^[\uDC00-\uDFFF]/u, "");
}
