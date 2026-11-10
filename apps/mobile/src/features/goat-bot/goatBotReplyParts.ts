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
// Lines that open another block: a table ends there, and a header cannot be one of them.
const OTHER_BLOCK =
  /^ {0,3}(?:>|#{1,6}(?:\s|$)|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|(?:[-*_] *){3,}$|`{3,}|~{3,})/;
const INDENTED = /^(?: {4}|\t)/;

/** A table row's cells, split at pipes a backslash does not escape. */
function cells(line: string): string[] {
  const inner = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

/** The header row of a table that starts here, or null when this line does not start one. */
function tableHeader(line: string, next: string | undefined): string[] | null {
  if (next === undefined || !line.includes("|") || !next.includes("-")) return null;
  if (INDENTED.test(line) || OTHER_BLOCK.test(line) || INDENTED.test(next)) return null;
  const header = cells(line);
  const delimiter = cells(next);
  return delimiter.length === header.length && delimiter.every((cell) => DELIMITER_CELL.test(cell))
    ? header
    : null;
}

/**
 * Splits a bot reply at its GFM tables, so each table can stand in its own card. A table is a
 * header row and a delimiter row with as many cells, then body rows up to a blank line or another
 * block; short rows are padded and extra cells dropped, as GFM does. Tables in fenced or indented
 * code, block quotes and list items stay in the prose around them.
 */
export function splitGoatBotReply(text: string): GoatBotReplyPart[] {
  const lines = text.split("\n");
  const parts: GoatBotReplyPart[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  const flushProse = () => {
    // Blank lines around a stretch go; its first line keeps its indent, which can mean code.
    const joined = prose
      .join("\n")
      .replace(/^(?:[ \t]*\n)+/, "")
      .trimEnd();
    if (joined.trim() !== "") parts.push({ kind: "prose", text: joined });
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
    const header = tableHeader(line, lines[index + 1]);
    if (header === null) {
      prose.push(line);
      continue;
    }
    let end = index + 2;
    const rows: string[][] = [];
    for (; end < lines.length; end += 1) {
      const row = lines[end] ?? "";
      if (row.trim() === "" || OTHER_BLOCK.test(row)) break;
      const found = cells(row);
      rows.push(header.map((_, column) => found[column] ?? ""));
    }
    flushProse();
    parts.push({ kind: "table", markdown: lines.slice(index, end).join("\n"), header, rows });
    index = end - 1;
  }
  flushProse();
  return parts.length === 0 ? [{ kind: "prose", text }] : parts;
}
