import type { Root, RootContent } from "mdast";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkParse from "remark-parse";
import { unified } from "unified";

// Without GFM a table is one paragraph; emphasis spanning its cells holds "|" and is vetoed below.
const parser = unified().use(remarkParse).use(remarkCjkFriendly).freeze();

const WORD_JOINER = "\u2060";
const NON_ASCII = /[\u0080-\uffff]/;
// A star run with punctuation inside and a letter outside, the only runs this repairs.
const REPAIRABLE_RUN = /[^\s\p{L}\p{N}*]\*+[^\s\p{P}\p{S}*]|[^\s\p{P}\p{S}*]\*+[^\s\p{L}\p{N}*]/u;
const WHITESPACE = /^[\t\n\v\f\r \p{Zs}]$/u;
const PUNCTUATION = /^[\p{P}\p{S}]$/u;
const ASCII_PUNCTUATION = /^[!-\/:-@\[-`{-~]$/;
// Native marks whose openers a newly paired emphasis could pop, and native autolink triggers.
const NATIVE_MARK = /[$|~=+^_]/;
const AUTOLINK_TRIGGER = /:\/\/|www\.|@/i;

type Node = Root | RootContent;
type Side = "open" | "close";
type CharClass = "space" | "punct" | "other";
type Emphasis = {
  readonly start: number;
  readonly end: number;
  readonly size: number;
  readonly hasLink: boolean;
};

function classify(char: string): CharClass {
  if (char === "" || WHITESPACE.test(char)) return "space";
  return PUNCTUATION.test(char) ? "punct" : "other";
}

function charBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const low = text.charCodeAt(index - 1);
  const high = text.charCodeAt(index - 2);
  const pair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  return text.slice(pair ? index - 2 : index - 1, index);
}

function charAt(text: string, index: number): string {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  while (text[index - 1 - backslashes] === "\\") backslashes += 1;
  return backslashes % 2 === 1;
}

/** A superset of the native parser's math spans: any "$" run to the last later run of its length. */
function dollarSpans(text: string, start: number, end: number): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (let index = start; index < end; index += 1) {
    if (text[index] === "\\" && ASCII_PUNCTUATION.test(text[index + 1] ?? "")) {
      index += 1;
      continue;
    }
    if (text[index] !== "$") continue;
    let runEnd = index;
    while (runEnd < end && text[runEnd] === "$") runEnd += 1;
    if (runEnd - index <= 2) runs.push([index, runEnd]);
    index = runEnd - 1;
  }
  const spans: Array<[number, number]> = [];
  runs.forEach(([runStart, runEnd], index) => {
    for (let later = runs.length - 1; later > index; later -= 1) {
      const [closerStart, closerEnd] = runs[later] ?? [0, 0];
      if (closerEnd - closerStart !== runEnd - runStart) continue;
      spans.push([runStart, closerEnd]);
      return;
    }
  });
  return spans;
}

/**
 * The native parser splits other runs differently under the rule of three, so a run must be one
 * emphasis, one strong, or both nested tightly as in "***x***".
 */
function regularRun(owners: readonly Emphasis[], length: number): boolean {
  if (owners.length === 1) return owners[0]?.size === length;
  const [outer, inner] = [...owners].sort((a, b) => a.start - b.start || b.end - a.end);
  return (
    length === 3 &&
    owners.length === 2 &&
    outer !== undefined &&
    inner !== undefined &&
    outer.size + inner.size === 3 &&
    inner.start - outer.start === outer.size &&
    outer.end - inner.end === outer.size
  );
}

/** Word joiner offsets for one inline block, or none when any repair could re-pair native marks. */
function blockInsertions(markdown: string, block: Node): number[] {
  const start = block.position?.start.offset;
  const end = block.position?.end.offset;
  if (start === undefined || end === undefined) return [];
  const delimiters = new Map<number, { side: Side; owner: Emphasis }>();
  const emphasis: Emphasis[] = [];
  const code: Array<[number, number]> = [];
  const collect = (node: Node): boolean => {
    let hasLink = node.type === "link" || node.type === "linkReference";
    if ("children" in node) for (const child of node.children) hasLink = collect(child) || hasLink;
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from === undefined || to === undefined) return hasLink;
    if (node.type === "inlineCode") code.push([from, to]);
    if ((node.type === "emphasis" || node.type === "strong") && markdown[from] === "*") {
      const owner = { start: from, end: to, size: node.type === "strong" ? 2 : 1, hasLink };
      for (let offset = 0; offset < owner.size; offset += 1) {
        delimiters.set(from + offset, { side: "open", owner });
        delimiters.set(to - owner.size + offset, { side: "close", owner });
      }
      emphasis.push(owner);
    }
    return hasLink;
  };
  if ("children" in block) block.children.forEach(collect);
  if (emphasis.length === 0) return [];

  // Every native star mark must be one of web's delimiters, so both parsers pair the same runs.
  for (let index = start; index < end; index += 1) {
    if (markdown[index] !== "*" || delimiters.has(index) || isEscaped(markdown, index)) continue;
    if (!code.some(([from, to]) => index >= from && index < to)) return [];
  }
  const spans = dollarSpans(markdown, start, end);
  for (const node of emphasis) {
    const lineStart = markdown.lastIndexOf("\n", node.start - 1) + 1;
    const lineEnd = markdown.indexOf("\n", node.end);
    if (
      node.hasLink ||
      NATIVE_MARK.test(markdown.slice(Math.max(node.start - 1, 0), node.end + 1)) ||
      AUTOLINK_TRIGGER.test(markdown.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)) ||
      spans.some(([from, to]) => node.start < to && from < node.end)
    )
      return [];
  }

  const insertions: number[] = [];
  const offsets = [...delimiters.keys()].sort((a, b) => a - b);
  for (let index = 0; index < offsets.length;) {
    const runStart = offsets[index] ?? 0;
    let runEnd = runStart;
    const sides = new Set<Side>();
    const owners = new Set<Emphasis>();
    while (offsets[index] === runEnd) {
      const delimiter = delimiters.get(runEnd);
      if (delimiter) {
        sides.add(delimiter.side);
        owners.add(delimiter.owner);
      }
      runEnd += 1;
      index += 1;
    }
    if (sides.size > 1 || !regularRun([...owners], runEnd - runStart)) return [];
    const before = classify(charBefore(markdown, runStart));
    const after = classify(charAt(markdown, runEnd));
    if (sides.has("open") && after === "punct" && before === "other") insertions.push(runEnd);
    if (sides.has("close") && before === "punct" && after === "other") insertions.push(runStart);
  }
  return insertions;
}

/**
 * Lets a CommonMark parser find the CJK emphasis that remark-cjk-friendly finds, such as
 * "**한글(강조)**입니다", by putting a word joiner inside delimiter runs that only fail CommonMark
 * flanking. Blocks where the parsers could pair stars differently are left as written.
 */
export function markdownWithCommonMarkCjkEmphasis(markdown: string): string {
  if (!NON_ASCII.test(markdown) || !REPAIRABLE_RUN.test(markdown)) return markdown;
  const insertions: number[] = [];
  const visit = (node: Node) => {
    if (node.type === "paragraph" || node.type === "heading") {
      insertions.push(...blockInsertions(markdown, node));
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(parser.parse(markdown));
  if (insertions.length === 0) return markdown;
  insertions.sort((a, b) => a - b);
  let result = "";
  let offset = 0;
  for (const insertion of insertions) {
    result += markdown.slice(offset, insertion) + WORD_JOINER;
    offset = insertion;
  }
  return result + markdown.slice(offset);
}
