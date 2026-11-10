export type GoatBotReplyPart =
  | { readonly kind: "prose"; readonly text: string }
  | {
      readonly kind: "table";
      /** The table exactly as written, to draw and to copy. */
      readonly markdown: string;
      readonly columns: number;
    };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const DELIMITER_CELL = /^:?-+:?$/;
// Lines that open another block, which ends a table.
const OTHER_BLOCK =
  /^ {0,3}(?:>|#{1,6}(?:\s|$)|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|(?:[-*_] *){3,}$|`{3,}|~{3,}|<)/;
// HTML blocks that run past blank lines, with what ends each.
const RAW_HTML: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/^ {0,3}<(?:pre|script|style|textarea)(?:\s|>|$)/i, /<\/(?:pre|script|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
];
// A link reference definition: its links may sit in another part, so such replies stay whole.
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:[ \t]*\S/m;

/** How many cells a table row has, counting pipes a backslash does not escape. */
function cellCount(line: string): number {
  const inner = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).length;
}

function isDelimiterRow(line: string): boolean {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").every((cell) => DELIMITER_CELL.test(cell.trim()));
}

/**
 * Whether a table may start at this line: after a blank line, or after a plain paragraph at the
 * left edge, which a table ends. A paragraph that holds a list item, quote or indented line could
 * carry the table as its continuation, so it may not.
 */
function startsBlock(lines: ReadonlyArray<string>, index: number): boolean {
  for (let back = index - 1; back >= 0; back -= 1) {
    const line = lines[back] ?? "";
    if (line.trim() === "") return true;
    if (/^\s/.test(line) || OTHER_BLOCK.test(line)) return false;
  }
  return true;
}

/**
 * Splits a bot reply at its tables so each can stand in its own card: a header row and a delimiter
 * row with as many cells at the left edge, outside any list, quote, HTML or code block, then rows up
 * to a blank line or another block. A reply with link reference definitions stays whole.
 */
export function splitGoatBotReply(text: string): GoatBotReplyPart[] {
  if (!text.includes("|") || REFERENCE_DEFINITION.test(text)) return [{ kind: "prose", text }];
  const lines = text.split("\n");
  const parts: GoatBotReplyPart[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  let rawEnd: RegExp | null = null;
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
    if (fence !== null) {
      const closer = FENCE_CLOSE.exec(line)?.[1];
      if (closer !== undefined && closer[0] === fence[0] && closer.length >= fence.length) {
        fence = null;
      }
      prose.push(line);
      continue;
    }
    if (rawEnd !== null) {
      if (rawEnd.test(line)) rawEnd = null;
      prose.push(line);
      continue;
    }
    const opener = FENCE_OPEN.exec(line)?.[1];
    if (opener !== undefined) {
      fence = opener;
      prose.push(line);
      continue;
    }
    const raw = RAW_HTML.find(([start]) => start.test(line));
    if (raw !== undefined) {
      if (!raw[1].test(line.replace(raw[0], ""))) rawEnd = raw[1];
      prose.push(line);
      continue;
    }
    const next = lines[index + 1];
    const columns = line.startsWith("|") || /^[^\s|>#<]/.test(line) ? cellCount(line) : 0;
    if (
      next === undefined ||
      !line.includes("|") ||
      OTHER_BLOCK.test(line) ||
      columns === 0 ||
      /^\s/.test(next) ||
      !isDelimiterRow(next) ||
      cellCount(next) !== columns ||
      !startsBlock(lines, index)
    ) {
      prose.push(line);
      continue;
    }
    let end = index + 2;
    while (end < lines.length) {
      const row = lines[end] ?? "";
      if (row.trim() === "" || OTHER_BLOCK.test(row)) break;
      end += 1;
    }
    flushProse();
    parts.push({ kind: "table", markdown: lines.slice(index, end).join("\n"), columns });
    index = end - 1;
  }
  flushProse();
  return parts.length === 0 ? [{ kind: "prose", text }] : parts;
}
