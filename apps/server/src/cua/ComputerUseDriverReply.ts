/**
 * The boundary where a computer use driver's tool results reach the agent's transcript (#1163).
 * GOAT receives screenshots inline as MCP image blocks and never reads a path or file handle a
 * driver names, so the checks here are on the bytes: an image must be a PNG or JPEG whose data is
 * base64, whose first bytes match its type, and which decodes to at most
 * COMPUTER_USE_SCREENSHOT_MAX_BYTES. Any other image block is replaced by a short note.
 *
 * @module ComputerUseDriverReply
 */
// Driver lines are forwarded as written; only the image blocks of a result are read.
// @effect-diagnostics preferSchemaOverJson:off

export const COMPUTER_USE_SCREENSHOT_MAX_BYTES = 25 * 1024 * 1024;

// A Map, so a mimeType such as "constructor" never finds an inherited property.
const SIGNATURES: ReadonlyMap<string, ReadonlyArray<number>> = new Map([
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const decodedLength = (data: string) =>
  Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);

/** Why an image block may not pass, or undefined when it may. */
function withheldReason(block: Record<string, unknown>): string | undefined {
  const mimeType = typeof block.mimeType === "string" ? block.mimeType.toLowerCase() : undefined;
  const signature = mimeType === undefined ? undefined : SIGNATURES.get(mimeType);
  if (signature === undefined) return "it is not a PNG or JPEG image";
  const data = block.data;
  if (typeof data !== "string" || data.length % 4 !== 0 || !BASE64.test(data))
    return "its data is not base64";
  if (decodedLength(data) > COMPUTER_USE_SCREENSHOT_MAX_BYTES) return "it is larger than 25 MiB";
  const head = Buffer.from(data.slice(0, 16), "base64");
  if (!signature.every((byte, index) => head[index] === byte))
    return `its bytes are not ${mimeType}`;
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseRecord = (line: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A driver line with every image block that fails the checks replaced by a note. Every line is
 * parsed: JSON can spell "image" with escapes, so no raw-text shortcut is safe.
 */
export function admitDriverReplyScreenshots(line: string): string {
  const message = parseRecord(line);
  const result = message?.result;
  if (message === undefined || !isRecord(result) || !Array.isArray(result.content)) return line;
  let changed = false;
  const content = result.content.map((block: unknown) => {
    if (!isRecord(block) || block.type !== "image") return block;
    const reason = withheldReason(block);
    if (reason === undefined) return block;
    changed = true;
    return { type: "text", text: `GOAT withheld a screenshot from this result: ${reason}.` };
  });
  return changed ? JSON.stringify({ ...message, result: { ...result, content } }) : line;
}

/** The outstanding-request key a provider's `notifications/cancelled` names, if the line is one. */
export function cancelledRequestKey(line: string): string | undefined {
  const message = parseRecord(line);
  if (message?.method !== "notifications/cancelled" || !isRecord(message.params)) return undefined;
  const requestId = message.params.requestId;
  return typeof requestId === "string" || typeof requestId === "number"
    ? JSON.stringify(requestId)
    : undefined;
}
