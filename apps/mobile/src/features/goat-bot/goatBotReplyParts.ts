export type GoatBotReplyPart =
  | { readonly kind: "prose"; readonly text: string }
  | {
      readonly kind: "table";
      readonly markdown: string;
      readonly header: ReadonlyArray<string>;
      readonly rows: ReadonlyArray<ReadonlyArray<string>>;
    };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const DELIMITER_CELL = /^:?-+:?$/;

/** A table row's cells, split at pipes a backslash does not escape; null when it has no pipe. */
function cells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const inner = trimmed.replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

/**
 * Splits a bot reply at its GFM tables outside fenced code, so each table can stand in its own
 * card. A table needs a header row, then a delimiter row with the same number of cells.
 */
export function splitGoatBotReply(text: string): GoatBotReplyPart[] {
  const lines = text.split("\n");
  const parts: GoatBotReplyPart[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  const flushProse = () => {
    const joined = prose.join("\n").trim();
    if (joined !== "") parts.push({ kind: "prose", text: joined });
    prose = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      prose.push(line);
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      prose.push(line);
      continue;
    }
    const header = cells(line);
    const next = lines[index + 1];
    const delimiter = next === undefined ? null : cells(next);
    if (
      header === null ||
      delimiter === null ||
      delimiter.length !== header.length ||
      !delimiter.every((cell) => DELIMITER_CELL.test(cell))
    ) {
      prose.push(line);
      continue;
    }
    let end = index + 2;
    const rows: string[][] = [];
    while (end < lines.length) {
      const row = cells(lines[end] ?? "");
      if (row === null) break;
      rows.push(row);
      end += 1;
    }
    flushProse();
    parts.push({
      kind: "table",
      markdown: lines.slice(index, end).join("\n"),
      header,
      rows,
    });
    index = end - 1;
  }
  flushProse();
  return parts.length === 0 ? [{ kind: "prose", text }] : parts;
}
