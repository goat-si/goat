import type { Root } from "mdast";
import type { Transformer } from "unified";

import { GITHUB_ALERT_MARKER } from "./markdownGithubAlerts.ts";
import { nativeMathSpans } from "./markdownCjkEmphasis.ts";

interface MarkdownPoint {
  readonly line: number;
  readonly column: number;
  readonly offset?: number | undefined;
}

interface MarkdownNode {
  readonly type: string;
  value?: string;
  url?: string;
  position?: { readonly start: MarkdownPoint; readonly end: MarkdownPoint } | undefined;
  children?: MarkdownNode[];
  data?: object | undefined;
}

type Container =
  | { readonly kind: "quote" }
  | { readonly kind: "item"; readonly node: MarkdownNode; indent?: number | null }
  // Recovered list content starts past the item's indentation, so its lines measure from there.
  | { readonly kind: "indent"; readonly indent: number };

interface Cursor {
  offset: number;
  column: number;
  /** The character at `offset` is a tab whose first columns are already taken. */
  insideTab: boolean;
}

interface Source {
  readonly text: string;
  readonly lineStarts: readonly number[];
  readonly nativeMath?: boolean;
  readonly onIndentation?: (indentation: Indentation, content: MarkdownNode) => void;
}

interface Indentation {
  readonly offset: number;
  readonly value: string;
}

const LINE_ENDING = /\r\n|\r|\n/g;
// Whitespace at a line start, or past a quote marker and its one optional space.
const MAY_KEEP_WHITESPACE = /(?:^|[\r\n])[ \t]|>(?:\t|[ \t]{2})/;
const LIST_MARKER = /[-*+]|\d{1,9}[.)]/y;
const INLINE_CONTAINERS = new Set(["emphasis", "strong", "delete", "link", "linkReference"]);
const nextTabStop = (column: number) => (Math.floor(column / 4) + 1) * 4;
const isBlank = (character: string | undefined) => character === " " || character === "\t";

function columnAt(source: Source, line: number, offset: number): number {
  let column = 0;
  for (let index = source.lineStarts[line - 1] ?? offset; index < offset; index++) {
    column = source.text[index] === "\t" ? nextTabStop(column) : column + 1;
  }
  return column;
}

/** Moves `width` columns through spaces and tabs, splitting a tab where it must. */
function skipColumns(source: Source, cursor: Cursor, width: number): boolean {
  let left = width;
  while (left > 0) {
    const character = source.text[cursor.offset];
    if (!isBlank(character)) return false;
    const step = character === " " ? 1 : nextTabStop(cursor.column) - cursor.column;
    if (step > left) {
      cursor.column += left;
      cursor.insideTab = true;
      return true;
    }
    cursor.offset += 1;
    cursor.column += step;
    cursor.insideTab = false;
    left -= step;
  }
  return true;
}

/**
 * Where the item's content starts on its own first line, and its column, measured from the marker
 * as CommonMark does. A task's checkbox is content, whatever GFM makes the paragraph's position.
 */
function itemContent(source: Source, item: MarkdownNode): Cursor | undefined {
  const start = item.position?.start;
  if (start?.offset === undefined) return undefined;
  LIST_MARKER.lastIndex = start.offset;
  const marker = LIST_MARKER.exec(source.text)?.[0];
  if (!marker) return undefined;
  const end = start.offset + marker.length;
  const cursor: Cursor = {
    offset: end,
    column: columnAt(source, start.line, end),
    insideTab: false,
  };
  let offset = end;
  let column = cursor.column;
  while (isBlank(source.text[offset])) {
    column = source.text[offset] === "\t" ? nextTabStop(column) : column + 1;
    offset += 1;
  }
  const character = source.text[offset];
  const blankLine = character === undefined || character === "\r" || character === "\n";
  if (!blankLine && column - cursor.column <= 4) return { offset, column, insideTab: false };
  // A blank first line, or code after five or more columns, starts one column past the marker.
  if (blankLine) return { ...cursor, column: cursor.column + 1 };
  skipColumns(source, cursor, 1);
  return cursor;
}

/** The end of the container markers and indentation on `line`, or nothing for a lazy line. */
function containerEnd(
  source: Source,
  line: number,
  chain: readonly Container[],
  depth = chain.length,
): Cursor | undefined {
  const offset = source.lineStarts[line - 1];
  if (offset === undefined) return undefined;
  const cursor: Cursor = { offset, column: 0, insideTab: false };
  for (let index = 0; index < depth; index++) {
    const container = chain[index];
    if (!container) return undefined;
    if (container.kind === "quote") {
      // Up to three columns of indentation, the marker, then one optional space.
      const indentation = { ...cursor };
      while (isBlank(source.text[cursor.offset]) && skipColumns(source, cursor, 1)) {
        if (cursor.column - indentation.column > 3) return undefined;
      }
      if (cursor.insideTab || source.text[cursor.offset] !== ">") return undefined;
      cursor.offset += 1;
      cursor.column += 1;
      if (isBlank(source.text[cursor.offset])) skipColumns(source, cursor, 1);
      continue;
    }
    if (container.kind === "item" && container.node.position?.start.line === line) {
      const content = itemContent(source, container.node);
      if (!content) return undefined;
      Object.assign(cursor, content);
      continue;
    }
    const indent =
      container.kind === "indent" ? container.indent : itemIndent(source, chain, index);
    if (indent === undefined || !skipColumns(source, cursor, indent)) return undefined;
  }
  return cursor;
}

/** The columns an item's continuation lines need past its parent's own markers. */
function itemIndent(
  source: Source,
  chain: readonly Container[],
  index: number,
): number | undefined {
  const item = chain[index];
  if (item?.kind !== "item") return undefined;
  if (item.indent === undefined) {
    const line = item.node.position?.start.line;
    const parent = line === undefined ? undefined : containerEnd(source, line, chain, index);
    const content = itemContent(source, item.node);
    item.indent = parent && content ? content.column - parent.column : null;
  }
  return item.indent ?? undefined;
}

/** The spaces and tabs typed on `line` that CommonMark drops, past what is structure. */
function typedWhitespace(
  source: Source,
  line: number,
  start: MarkdownPoint,
  chain: readonly Container[],
): Indentation | undefined {
  const cursor = containerEnd(source, line, chain);
  if (!cursor) return undefined;
  let end = cursor.offset;
  if (line === start.line) end = start.offset ?? end;
  else while (isBlank(source.text[end])) end++;
  const typed = source.text.slice(cursor.offset, end);
  if (!/^[ \t]+$/.test(typed)) return undefined;
  return {
    offset: end,
    value: cursor.insideTab
      ? " ".repeat(nextTabStop(cursor.column) - cursor.column) + typed.slice(1)
      : typed,
  };
}

function whitespaceNode(value: string): MarkdownNode {
  return {
    type: "text",
    value,
    // Converting to HTML trims a whitespace-only text, and the first text after a line break;
    // the empty text takes that trim.
    data: {
      hName: "span",
      hProperties: { dataLeadingWhitespace: "", ariaHidden: true },
      hChildren: [
        { type: "text", value: "" },
        { type: "text", value },
      ],
    },
  };
}

/** Whether `node` starts with a space, tab or line ending, which a line start drops or hides. */
function startsBlank(node: MarkdownNode): boolean {
  if (typeof node.value === "string") return /^[ \t\r\n]/.test(node.value);
  const first = node.children?.[0];
  return first !== undefined && startsBlank(first);
}

// Split or trimmed texts drop their position: nothing later reads a text node's.
function withValue({ position: _position, ...text }: MarkdownNode, value: string): MarkdownNode {
  return { ...text, value };
}

/** `node` with the start trim that converting to HTML gives whatever follows a line break. */
function trimmedAfterBreak(node: MarkdownNode): MarkdownNode {
  const value = node.value ?? "";
  if (node.type === "text" && /^[ \t]/.test(value)) {
    return withValue(node, value.replace(/^[ \t]+/, ""));
  }
  // Code turns its line endings into spaces first.
  if (node.type === "inlineCode" && /^[ \t\r\n]/.test(value)) {
    return { ...node, value: value.replace(/^(?:[ \t]|\r?\n|\r)+/, "") };
  }
  const children = node.children ?? [];
  const head = children[0];
  if (INLINE_CONTAINERS.has(node.type) && node.type !== "linkReference" && head?.type === "text") {
    return { ...node, children: [trimmedAfterBreak(head), ...children.slice(1)] };
  }
  return node;
}

/**
 * Converting to HTML trims the start of the node after a line break, and the span now takes that
 * place, so the node after the span gets the same trim. A line whose content still starts with
 * whitespace, which the browser hides at a line start, keeps no span, so it shows as without one.
 */
function settle(children: MarkdownNode[], at: number, afterBreak: boolean) {
  const next = children[at + 1];
  if (afterBreak && next) children[at + 1] = trimmedAfterBreak(next);
  let index = at + 1;
  while (children[index]?.type === "text" && children[index]?.value === "") index++;
  const content = children[index];
  if (content && content.type !== "break" && !startsBlank(content)) return content;
  children.splice(at, 1);
}

function restoreParagraph(
  source: Source,
  paragraph: MarkdownNode,
  chain: readonly Container[],
  skipFirstLine: boolean,
): void {
  const start = paragraph.position?.start;
  if (start?.offset === undefined || !paragraph.children) return;
  const end = paragraph.position?.end.offset;
  const math =
    source.nativeMath && end !== undefined ? nativeMathSpans(source.text, start.offset, end) : [];
  const typed = (at: number) => {
    const entry = typedWhitespace(source, at, start, chain);
    return entry && !math.some(([from, to]) => entry.offset > from && entry.offset < to)
      ? entry
      : undefined;
  };
  const inserted = new Map<MarkdownNode, Indentation>();
  const indentation = (entry: Indentation) => {
    const node = whitespaceNode(entry.value);
    inserted.set(node, entry);
    return node;
  };
  // Nodes a plugin made without a position follow on from their siblings.
  let line = start.line;

  const split = (text: MarkdownNode): MarkdownNode[] => {
    const value = text.value ?? "";
    const endings = [...value.matchAll(LINE_ENDING)];
    // A character reference such as `&#10;` adds a line ending the source does not have.
    if (
      endings.length === 0 ||
      (text.position && text.position.end.line - text.position.start.line !== endings.length)
    ) {
      return [text];
    }
    const parts: MarkdownNode[] = [];
    let cut = 0;
    for (const ending of endings) {
      line += 1;
      const whitespace = typed(line);
      if (!whitespace) continue;
      const at = ending.index + ending[0].length;
      parts.push(withValue(text, value.slice(cut, at)), indentation(whitespace));
      cut = at;
    }
    if (parts.length === 0) return [text];
    if (cut < value.length) parts.push(withValue(text, value.slice(cut)));
    return parts;
  };

  const walk = (parent: MarkdownNode) => {
    const children: MarkdownNode[] = [];
    for (const child of parent.children ?? []) {
      line = child.position?.start.line ?? line;
      if (child.type === "text") {
        children.push(...split(child));
      } else {
        children.push(child);
        if (child.type === "break") {
          line = child.position?.end.line ?? line + 1;
          const whitespace = typed(line);
          if (whitespace) children.push(indentation(whitespace));
        } else if (INLINE_CONTAINERS.has(child.type)) {
          walk(child);
        }
      }
      line = child.position?.end.line ?? line;
    }
    // From the end, so settling one span leaves the earlier ones' places as they are.
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index];
      const entry = child && inserted.get(child);
      if (entry) {
        const content = settle(children, index, true);
        if (content) source.onIndentation?.(entry, content);
      }
    }
    parent.children = children;
  };

  const first = skipFirstLine ? undefined : typed(start.line);
  walk(paragraph);
  if (first) {
    paragraph.children.unshift(indentation(first));
    const content = settle(paragraph.children, 0, false);
    if (content) source.onIndentation?.(first, content);
  }
}

// The alert plugin reads the marker from the first text, and drops the marker's line.
function startsWithAlertMarker(paragraph: MarkdownNode): boolean {
  const first = paragraph.children?.[0];
  return first?.type === "text" && GITHUB_ALERT_MARKER.test(first.value ?? "");
}

function visit(
  source: Source,
  node: MarkdownNode,
  chain: readonly Container[],
  firstInQuote: boolean,
): void {
  if (node.type === "paragraph") {
    restoreParagraph(source, node, chain, firstInQuote && startsWithAlertMarker(node));
    return;
  }
  // Other containers, such as footnote definitions, keep CommonMark's reading.
  const inner =
    node.type === "root" || node.type === "list"
      ? chain
      : node.type === "blockquote"
        ? [...chain, { kind: "quote" } as const]
        : node.type === "listItem"
          ? [...chain, { kind: "item", node } as const]
          : undefined;
  if (!inner) return;
  node.children?.forEach((child, index) =>
    visit(source, child, inner, node.type === "blockquote" && index === 0),
  );
}

/**
 * CommonMark drops the spaces and tabs at the start of each line of a paragraph. This puts back
 * what was typed past the structure CommonMark reads, such as a list item's indentation or a
 * quote's marker, in spans the stylesheet keeps whitespace in. `source` is the text the node's
 * offsets point into; `indent` is how far its lines are already indented.
 */
export function keepLeadingWhitespace(
  node: { readonly type: string; readonly children?: readonly object[] | undefined },
  source: string,
  indent = 0,
): void {
  const positioned = positionedSource(source);
  if (!positioned) return;
  const chain: Container[] = indent > 0 ? [{ kind: "indent", indent }] : [];
  visit(positioned, node as MarkdownNode, chain, false);
}

function positionedSource(text: string): Source | undefined {
  if (!MAY_KEEP_WHITESPACE.test(text)) return undefined;
  const lineStarts = [0];
  for (const ending of text.matchAll(LINE_ENDING)) lineStarts.push(ending.index + ending[0].length);
  return { text, lineStarts };
}

// GFM misses some URLs md4c accepts, including FTP and single-label hosts.
const NATIVE_SCHEME_LINK =
  /(?:https?|ftp):\/\/[a-z0-9_][^\s<>"'\[\]{}()]*(?:\([^\s()]*\)[^\s<>"'\[\]{}()]*)*/iy;

function nativeLinkAt(markdown: string, offset: number, content: MarkdownNode) {
  const end = content.position?.end.offset;
  if (
    content.type === "link" &&
    content.url &&
    content.position?.start.offset === offset &&
    end !== undefined &&
    markdown[offset] !== "[" &&
    markdown[offset] !== "<"
  ) {
    const label = markdown.slice(offset, end);
    if (content.url === label || content.url === `mailto:${label}`) {
      return { end, text: `<${label}>` };
    }
    const escaped = label.replace(/[\\[\]`*_~.:@&]/g, (char) => `&#${char.charCodeAt(0)};`);
    const href = content.url.replaceAll("&", "&amp;").replaceAll(">", "%3E");
    return { end, text: `[${escaped}](<${href}>)` };
  }
  NATIVE_SCHEME_LINK.lastIndex = offset;
  const url = NATIVE_SCHEME_LINK.exec(markdown)?.[0].replace(/[?!.,:;*]+$/, "");
  return url ? { end: offset + url.length, text: `<${url}>` } : undefined;
}

export function markdownWithLeadingWhitespace(
  markdown: string,
  parse: (text: string) => Root,
  nativeMath = false,
) {
  const source = positionedSource(markdown);
  if (!source) return markdown;
  const edits = new Map<number, { end: number; text: string }>();
  // Native reparses the source. Entities preserve spaces and tabs without turning lines into code.
  visit(
    {
      ...source,
      nativeMath,
      onIndentation: ({ offset, value }, content) => {
        const whitespace = value.replaceAll(" ", "&#32;").replaceAll("\t", "&#9;");
        // An entity's semicolon prevents md4c from recognizing a following bare link.
        const link = nativeLinkAt(markdown, offset, content);
        edits.set(offset, { end: link?.end ?? offset, text: whitespace + (link?.text ?? "") });
      },
    },
    parse(markdown),
    [],
    false,
  );
  let start = 0;
  const parts: string[] = [];
  for (const [offset, edit] of [...edits].sort(([a], [b]) => a - b)) {
    parts.push(markdown.slice(start, offset), edit.text);
    start = edit.end;
  }
  return parts.length ? parts.join("") + markdown.slice(start) : markdown;
}

const enabledProcessors = new WeakSet<object>();

/**
 * Opts a processor in. User messages use it so the sent bubble shows each line as it was typed
 * and the agent received it; agent replies and files keep CommonMark's reading.
 */
function enableLeadingWhitespace(this: object): undefined {
  enabledProcessors.add(this);
}

export const remarkEnableLeadingWhitespace = enableLeadingWhitespace;

export function keepsLeadingWhitespace(processor: object): boolean {
  return enabledProcessors.has(processor);
}

/** Sits before plugins that split text without positions, and before list recovery. */
function attachLeadingWhitespace(this: object): Transformer<Root> {
  return (tree, file) => {
    if (enabledProcessors.has(this)) keepLeadingWhitespace(tree, String(file));
  };
}

export const remarkKeepLeadingWhitespace = attachLeadingWhitespace;
