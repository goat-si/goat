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
// Lines that open another block, which ends a table. HTML means GFM's block tags or <! / <?; inline
// tags and autolinks such as <strong> or <https://…> stay in their row.
const OTHER_BLOCK =
  /^ {0,3}(?:>|#{1,6}(?:\s|$)|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|(?:[-*_] *){3,}$|`{3,}|~{3,}|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul|pre|script|style|textarea)(?:[\s/>]|$)|<[!?])/i;
// HTML blocks that run past blank lines, with what ends each.
const RAW_HTML: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/^ {0,3}<(?:pre|script|style|textarea)(?:\s|>|$)/i, /<\/(?:pre|script|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
];
// A link reference definition's label, at any indent and inside list items or block quotes (its
// destination may follow on the next line): its links may sit in another part, so such replies
// stay whole. A label still open at the end of its line may close on the next, so it counts too.
const DEFINITION_START = /^[ \t]*(?:(?:>|[-*+]|\d{1,9}[.)])[ \t]*)*\[(?:[^\]\\]|\\.)*(?:\]:|\\?$)/;
// A list item or block quote, which can hold an indented table below it.
const CONTAINER = /^ {0,3}(?:>|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$))/;
const LEAD = /^ {1,3}(?=\S)/;

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
 * Splits a bot reply at its tables so each can stand in its own card: a header row and a delimiter
 * row with as many cells, indented at most three spaces and outside any list, quote, HTML or code
 * block, then rows up to a blank line or another block. A reply with link reference definitions
 * outside code stays whole. One pass over the lines.
 */
export function splitGoatBotReply(text: string): GoatBotReplyPart[] {
  const whole = [{ kind: "prose" as const, text }];
  if (!text.includes("|")) return whole;
  const lines = text.split("\n");
  const parts: GoatBotReplyPart[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  // Whether a list item or quote came before, after which an indented line may belong to it.
  let sawContainer = false;
  // Whether the lines read last are an indented code block.
  let indentedCode = false;
  // Whether the paragraph run since the last blank line holds a list item, quote, HTML, code or
  // indented line, which could carry a table below it as a continuation.
  let held = false;
  const keep = (line: string, code = false) => {
    prose.push(line);
    held = line.trim() === "" ? false : held || code || /^\s/.test(line) || OTHER_BLOCK.test(line);
  };
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
      keep(line, true);
      continue;
    }
    if (rawEnd !== null) {
      if (rawEnd.test(line)) rawEnd = null;
      keep(line, true);
      continue;
    }
    const opener = FENCE_OPEN.exec(line)?.[1];
    if (opener !== undefined) {
      fence = opener;
      keep(line, true);
      continue;
    }
    const raw = RAW_HTML.find(([start]) => start.test(line));
    if (raw !== undefined) {
      if (!raw[1].test(line.replace(raw[0], ""))) rawEnd = raw[1];
      keep(line, true);
      continue;
    }
    if (line.trim() !== "") {
      const afterBlank = index === 0 || (lines[index - 1] ?? "").trim() === "";
      // An unindented paragraph after a blank line ends any list or quote above it.
      if (afterBlank && /^\S/.test(line) && !CONTAINER.test(line)) sawContainer = false;
      indentedCode = /^(?: {4}|\t)/.test(line) && !sawContainer && (indentedCode || afterBlank);
    }
    if (!indentedCode && DEFINITION_START.test(line)) return whole;
    if (CONTAINER.test(line)) sawContainer = true;
    const next = lines[index + 1];
    // Up to three spaces before a table, unless a list or quote above could own the indent.
    const header = sawContainer ? line : line.replace(LEAD, "");
    const delimiter = next === undefined || sawContainer ? next : next.replace(LEAD, "");
    const columns = header.startsWith("|") || /^[^\s|>#]/.test(header) ? cellCount(header) : 0;
    if (
      delimiter === undefined ||
      indentedCode ||
      !line.includes("|") ||
      OTHER_BLOCK.test(line) ||
      columns === 0 ||
      /^\s/.test(delimiter) ||
      !isDelimiterRow(delimiter) ||
      cellCount(delimiter) !== columns ||
      held
    ) {
      keep(line);
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
    held = false;
    index = end - 1;
  }
  flushProse();
  return parts.length === 0 ? [{ kind: "prose", text }] : parts;
}

/** A key for each part: where it starts in the reply, which stays put while the reply streams on. */
export function goatBotReplyPartKeys(
  text: string,
  parts: ReadonlyArray<GoatBotReplyPart>,
): ReadonlyArray<string> {
  let from = 0;
  return parts.map((part) => {
    const words = part.kind === "table" ? part.markdown : part.text;
    const at = text.indexOf(words, from);
    const start = at < 0 ? from : at;
    from = at < 0 ? from : at + words.length;
    return `${part.kind}:${start}`;
  });
}
