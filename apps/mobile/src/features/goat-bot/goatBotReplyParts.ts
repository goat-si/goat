import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type GoatBotReplyPart = (
  | { readonly kind: "prose"; readonly text: string }
  | {
      readonly kind: "table";
      /** The table exactly as written, to draw and to copy. */
      readonly markdown: string;
      readonly columns: number;
    }
) & {
  /** Link reference definitions written in another part that this one refers to. */
  readonly definitions?: string;
};

/** What a part draws: its own Markdown, then the definitions it carries from elsewhere. */
export const goatBotReplyPartSource = (part: GoatBotReplyPart): string => {
  const own = part.kind === "table" ? part.markdown : part.text;
  return part.definitions === undefined ? own : own + "\n\n" + part.definitions;
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
// A list item's marker and the spaces after it: lines indented this far after a blank line still
// belong to the item.
const LIST_ITEM = /^( {0,3}(?:[-*+]|\d{1,9}[.)]))( *)(\S?)/;
// A list item or quote opening another one on the same line, such as "> - a" or "- > a".
const NESTED_ON_LINE =
  /^ {0,3}(?:>|[-*+][ \t]|\d{1,9}[.)][ \t])[ \t]*(?:>|[-*+][ \t]|\d{1,9}[.)][ \t])/;
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
 * row with as many cells, at most three spaces in and outside any list, quote, HTML or code block,
 * then rows up to a blank line or another block. Definitions go to the parts that use them.
 */
export function splitGoatBotReply(text: string): GoatBotReplyPart[] {
  const whole = [{ kind: "prose" as const, text }];
  if (!text.includes("|")) return whole;
  const lines = text.split("\n");
  const parts: GoatBotReplyPart[] = [];
  // Each part's first and last line, for placing the reply's definitions.
  const spans: Array<readonly [number, number]> = [];
  let sawDefinition = false;
  let prose: string[] = [];
  let proseFrom = 0;
  let fence: string | null = null;
  // The list item or quote above, if any, after which an indented line may belong to it: a quote
  // ends at a blank line, a list item takes later lines indented as far as its text.
  let container: { readonly quote: true } | { readonly indent: number } | null = null;
  // Whether more than one list or quote level may be open, or a tab makes the indent unclear. Only
  // the innermost is tracked, so then just an unindented line is surely outside them all.
  let nested = false;
  // Whether the lines read last are an indented code block.
  let indentedCode = false;
  // Whether the paragraph run since the last blank line holds a list item, quote, HTML, code or
  // indented line, which could carry a table below it as a continuation.
  let held = false;
  const keep = (line: string, index: number, code = false) => {
    if (prose.length === 0) proseFrom = index;
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
    if (joined.trim() !== "") {
      parts.push({ kind: "prose", text: joined });
      spans.push([proseFrom, proseFrom + prose.length - 1]);
    }
    prose = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (fence !== null) {
      const closer = FENCE_CLOSE.exec(line)?.[1];
      if (closer !== undefined && closer[0] === fence[0] && closer.length >= fence.length) {
        fence = null;
      }
      keep(line, index, true);
      continue;
    }
    if (rawEnd !== null) {
      if (rawEnd.test(line)) rawEnd = null;
      keep(line, index, true);
      continue;
    }
    const opener = FENCE_OPEN.exec(line)?.[1];
    if (opener !== undefined) {
      fence = opener;
      keep(line, index, true);
      continue;
    }
    const raw = RAW_HTML.find(([start]) => start.test(line));
    if (raw !== undefined) {
      if (!raw[1].test(line.replace(raw[0], ""))) rawEnd = raw[1];
      keep(line, index, true);
      continue;
    }
    if (line.trim() !== "") {
      const afterBlank = index === 0 || (lines[index - 1] ?? "").trim() === "";
      const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
      if (container !== null && lead.includes("\t")) nested = true;
      if (afterBlank && container !== null && !CONTAINER.test(line)) {
        const ends = nested
          ? lead.length === 0
          : "quote" in container || lead.length < container.indent;
        if (ends) {
          container = null;
          nested = false;
        }
      }
      indentedCode =
        /^(?: {4}|\t)/.test(line) && container === null && (indentedCode || afterBlank);
    }
    if (!indentedCode && DEFINITION_START.test(line)) {
      sawDefinition = true;
      keep(line, index);
      continue;
    }
    if (CONTAINER.test(line)) {
      const item = LIST_ITEM.exec(line);
      const indented = /^[ \t]/.test(line);
      if (NESTED_ON_LINE.test(line) || (container !== null && indented)) nested = true;
      else if (!indented) nested = false;
      // Text one to four spaces after the marker sets the item's indent; otherwise one space does.
      const gap = item?.[2]?.length ?? 0;
      container =
        item === null
          ? { quote: true }
          : { indent: (item[1]?.length ?? 0) + (gap <= 4 && item[3] ? gap : 1) };
    }
    const sawContainer = container !== null;
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
      keep(line, index);
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
    spans.push([index, end - 1]);
    held = false;
    index = end - 1;
  }
  flushProse();
  if (parts.length === 0) return [{ kind: "prose", text }];
  if (!sawDefinition || parts.length === 1) return sawDefinition ? whole : parts;
  return carryDefinitions(text, parts, spans) ?? whole;
}

// The chat's Markdown grammar, so a definition is found where the renderer finds it.
const parser = unified().use(remarkParse).use(remarkGfm).freeze();

interface Destination {
  readonly url: string;
  readonly title: string | null;
}

/** What each reference in a document points at, in order; null where it resolves to nothing. */
function referenceDestinations(tree: Root): ReadonlyArray<Destination | null> {
  const defined = new Map<string, Destination>();
  const references: string[] = [];
  const walk = (nodes: ReadonlyArray<Nodes>) => {
    for (const node of nodes) {
      if (node.type === "definition") {
        if (!defined.has(node.identifier))
          defined.set(node.identifier, { url: node.url, title: node.title ?? null });
        continue;
      }
      if (node.type === "linkReference" || node.type === "imageReference")
        references.push(node.identifier);
      if ("children" in node) walk(node.children);
    }
  };
  walk(tree.children);
  return references.map((identifier) => defined.get(identifier) ?? null);
}

const sameDestinations = (
  a: ReadonlyArray<Destination | null>,
  b: ReadonlyArray<Destination | null>,
) =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i];
    return x === null || y === undefined || y === null
      ? x === y
      : x.url === y.url && x.title === y.title;
  });

/**
 * Gives each part the reply's definitions written in another part that it refers to, or null when
 * that cannot keep every link exactly where the whole reply sends it. Only definitions at the top
 * level, each once, wholly inside a prose part qualify; footnotes keep the reply whole. The parts
 * are parsed again and their references must point where the whole reply's did, in order.
 */
function carryDefinitions(
  text: string,
  parts: ReadonlyArray<GoatBotReplyPart>,
  spans: ReadonlyArray<readonly [number, number]>,
): GoatBotReplyPart[] | null {
  const tree = parser.parse(text);
  const definitions: Array<{ identifier: string; source: string; part: number }> = [];
  let footnotes = false;
  const nestedDefinition = (nodes: ReadonlyArray<Nodes>, top: boolean): boolean =>
    nodes.some((node) => {
      if (node.type === "footnoteDefinition" || node.type === "footnoteReference") footnotes = true;
      if (node.type === "definition" && !top) return true;
      return "children" in node && nestedDefinition(node.children, false);
    });
  if (nestedDefinition(tree.children, true) || footnotes) return null;
  for (const node of tree.children) {
    if (node.type !== "definition") continue;
    const start = node.position?.start;
    const end = node.position?.end;
    if (start?.offset === undefined || end?.offset === undefined) return null;
    if (definitions.some((each) => each.identifier === node.identifier)) return null;
    const part = spans.findIndex(([from, to]) => from <= start.line - 1 && end.line - 1 <= to);
    if (part < 0 || parts[part]?.kind !== "prose") return null;
    definitions.push({
      identifier: node.identifier,
      source: text.slice(start.offset, end.offset),
      part,
    });
  }
  const carried = parts.map((part, index) => {
    const elsewhere = definitions.filter((each) => each.part !== index);
    if (elsewhere.length === 0) return part;
    // A reference parses only beside its definition, so read the part with all of them.
    const own = goatBotReplyPartSource(part);
    const used = new Set<string>();
    const collect = (nodes: ReadonlyArray<Nodes>) => {
      for (const node of nodes) {
        if (node.type === "linkReference" || node.type === "imageReference")
          used.add(node.identifier);
        if (node.type !== "definition" && "children" in node) collect(node.children);
      }
    };
    collect(
      parser.parse(own + "\n\n" + elsewhere.map((each) => each.source).join("\n\n")).children,
    );
    const kept = elsewhere.filter((each) => used.has(each.identifier));
    return kept.length === 0
      ? part
      : { ...part, definitions: kept.map((each) => each.source).join("\n\n") };
  });
  const whole = referenceDestinations(tree);
  const split = carried.flatMap((part) =>
    referenceDestinations(parser.parse(goatBotReplyPartSource(part))),
  );
  if (!sameDestinations(whole, split)) return null;
  // A stretch of nothing but definitions draws nothing, so it gets no card of its own.
  return carried.filter(
    (part, index) =>
      part.kind !== "prose" ||
      !parser
        .parse(part.text)
        .children.every(
          (node) => node.type === "definition" && definitions.some((each) => each.part === index),
        ),
  );
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
