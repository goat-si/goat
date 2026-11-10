export interface GoatBotReplyPart {
  readonly kind: "text" | "table";
  readonly text: string;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
// A GFM delimiter row: cells of dashes with optional colons, and at least one pipe.
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isDelimiter = (line: string) => line.includes("|") && DELIMITER.test(line);

/**
 * Splits a bot answer into the text around its tables and each table, so a client can draw a
 * table on its own card. Fenced code is never split.
 */
export function goatBotReplyParts(text: string): ReadonlyArray<GoatBotReplyPart> {
  if (!text.includes("|")) return [{ kind: "text", text }];
  const lines = text.split("\n");
  const parts: Array<GoatBotReplyPart> = [];
  let buffer: Array<string> = [];
  let fence: string | null = null;
  const flush = (kind: GoatBotReplyPart["kind"]) => {
    const joined = buffer.join("\n").replace(/^\n+|\s+$/g, "");
    if (joined.trim() !== "") parts.push({ kind, text: joined });
    buffer = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined && (fence === null || marker.startsWith(fence))) {
      fence = fence === null ? marker : null;
    }
    const next = lines[index + 1];
    if (fence === null && line.includes("|") && next !== undefined && isDelimiter(next)) {
      flush("text");
      buffer.push(line, next);
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        buffer.push(lines[index] ?? "");
        index += 1;
      }
      index -= 1;
      flush("table");
      continue;
    }
    buffer.push(line);
  }
  flush("text");
  return parts.length > 0 ? parts : [{ kind: "text", text }];
}
