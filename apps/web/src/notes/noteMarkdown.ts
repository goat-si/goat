import type { JSONContent } from "@tiptap/core";
import type { List, Paragraph, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  parseInlineMarkdown,
  RICH_TEXT_DELIMITERS,
  type RichTextMark,
} from "../composer-rich-text";

// Source is retained per block, so editing a heading never rewrites an adjacent table or fence.
function fingerprintValue(node: JSONContent): unknown[] {
  return [
    node.type,
    node.text,
    ...["level", "checked", "start", "language"].map((key) => node.attrs?.[key] ?? null),
    node.marks?.map((mark) => mark.type).sort() ?? [],
    node.content?.map(fingerprintValue) ?? [],
  ];
}

function fingerprint(node: JSONContent): string {
  return JSON.stringify(fingerprintValue(node));
}

function text(value: string): JSONContent[] {
  return value ? [{ type: "text", text: value }] : [];
}

function inline(value: string): JSONContent[] | null {
  // Links, escapes, HTML, images and extension syntax stay literal until the note codec supports them.
  if (/[\\[\]<>]|!\[|\$| {2}\n/.test(value)) return null;
  if (/`{2,}/.test(value)) return null;
  const lines = value.split("\n");
  for (const line of lines) {
    let backticks = 0;
    for (const character of line) if (character === "`") backticks++;
    if (backticks % 2 !== 0) return null;
  }
  return lines.flatMap((line, index) => [
    ...(index ? [{ type: "hardBreak" }] : []),
    ...parseInlineMarkdown(line)
      .filter((span) => span.text)
      .map((span) => ({
        type: "text",
        text: span.text,
        marks: span.marks.map((type) => ({ type })),
      })),
  ]);
}

// Reuse the renderer's CommonMark/GFM grammar; the AST only owns kinds and source boundaries.
const parser = unified().use(remarkParse).use(remarkGfm).freeze();

function paragraph(node: Paragraph, markdown: string, quoted = false): JSONContent | null {
  // GFM may leave the paragraph start before a removed checkbox when emphasis comes first.
  const start = node.children[0]?.position?.start.offset ?? node.position!.start.offset!;
  const lines = markdown.slice(start, node.position!.end.offset!).split("\n");
  // Only canonical quote prefixes can be serialized without changing their source.
  if (quoted) {
    for (let index = 1; index < lines.length; index++) {
      if (!lines[index]!.startsWith("> ")) return null;
      lines[index] = lines[index]!.slice(2);
    }
  }
  const source = lines.join("\n");
  const content = source.includes("|") ? null : inline(source);
  return content ? { type: "paragraph", content } : null;
}

// Expose the existing subset: one single-line paragraph followed by nested lists per item.
// Parser children, rather than indentation guesses, decide what belongs to each item.
function list(node: List, markdown: string): JSONContent | null {
  const task = node.children[0]?.checked != null;
  const type = task ? "taskList" : node.ordered ? "orderedList" : "bulletList";
  const items: JSONContent[] = [];
  for (const item of node.children) {
    if ((item.checked != null) !== task) return null;
    const first = item.children[0];
    if (first?.type !== "paragraph" || first.position!.start.line !== first.position!.end.line)
      return null;
    const start = first.children[0]?.position?.start.offset;
    if (task && start !== undefined && markdown[start] === " ") return null;
    const firstParagraph = paragraph(first, markdown);
    if (!firstParagraph) return null;
    const content = [firstParagraph];
    for (const child of item.children.slice(1)) {
      if (child.type !== "list") return null;
      const nested = list(child, markdown);
      if (!nested) return null;
      content.push(nested);
    }
    items.push({
      type: task ? "taskItem" : "listItem",
      ...(task ? { attrs: { checked: item.checked } } : {}),
      content,
    });
  }
  return {
    type,
    ...(type === "orderedList" ? { attrs: { start: node.start } } : {}),
    content: items,
  };
}

function raw(source: string): JSONContent {
  return { type: "noteRawMarkdown", content: text(source) };
}

function block(source: string, node: RootContent, markdown: string): JSONContent {
  const lines = source.split("\n");
  if (node.type === "code") {
    const fence = /^(`{3,}|~{3,})([^\s`~]*)\s*$/.exec(lines[0]!);
    if (fence && lines.length > 1) {
      const close = lines.at(-1)!;
      if (new RegExp(`^${fence[1]![0]}{${fence[1]!.length},}\\s*$`).test(close)) {
        return {
          type: "codeBlock",
          attrs: { language: fence[2] },
          content: text(lines.slice(1, -1).join("\n")),
        };
      }
    }
  } else if (node.type === "heading") {
    const heading = /^(#{1,6}) (.*)$/.exec(source);
    const content = heading && inline(heading[2]!);
    if (heading && content)
      return { type: "heading", attrs: { level: heading[1]!.length }, content };
  } else if (node.type === "thematicBreak") {
    return { type: "horizontalRule" };
  } else if (node.type === "list") {
    return list(node, markdown) ?? raw(source);
  } else if (node.type === "blockquote") {
    const child = node.children[0];
    if (node.children.length === 1 && child?.type === "paragraph") {
      const content = paragraph(child, markdown, true);
      if (content) return { type: "blockquote", content: [content] };
    }
  } else if (node.type === "paragraph") {
    return paragraph(node, markdown) ?? raw(source);
  }
  return raw(source);
}

// Called once when an editor document loads. Edits serialize the editor tree without parsing.
export function noteMarkdownToDoc(markdown: string): JSONContent {
  // Keep CRLF documents literal; normalization would change unrelated lines on the next save.
  if (markdown.includes("\r"))
    return { type: "doc", content: [{ ...raw(markdown), attrs: { noteSuffix: "" } }] };
  const nodes = parser.parse(markdown).children;
  const content: JSONContent[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    const start = node.position!.start.offset!;
    let end = node.position!.end.offset!;
    let overlapping = false;
    // Setext headings can overlap preceding definitions in the parser's source positions.
    while (index + 1 < nodes.length && nodes[index + 1]!.position!.start.offset! < end) {
      overlapping = true;
      end = Math.max(end, nodes[++index]!.position!.end.offset!);
    }
    const source = markdown.slice(start, end);
    const next = nodes[index + 1];
    const suffix = markdown.slice(end, next?.position!.start.offset);
    const candidate = overlapping ? raw(source) : block(source, node, markdown);
    // Check the entire tree once: a noncanonical child keeps its containing block literal.
    const parsed = serializeBlock(candidate) === source ? candidate : raw(source);
    parsed.attrs = {
      ...parsed.attrs,
      notePrefix: content.length === 0 ? markdown.slice(0, start) : "",
      noteSource: source,
      noteFingerprint: fingerprint(parsed),
      noteSuffix: suffix,
    };
    content.push(parsed);
  }
  return {
    type: "doc",
    content: content.length
      ? content
      : [{ ...(markdown ? raw(markdown) : { type: "paragraph" }), attrs: { noteSuffix: "" } }],
  };
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

function inlineText(node: JSONContent): string {
  if (node.type === "hardBreak") return "\n";
  const raw = node.text ?? "";
  if (!node.marks?.some((mark) => mark.type === "code"))
    return raw.replace(/([\\`*_[\]<>~])/g, "\\$1");
  // Code encloses only the text, regardless of the schema's mark order.
  const length = longestBacktickRun(raw) + 1;
  const fence = "`".repeat(length);
  const pad =
    raw.startsWith("`") ||
    raw.endsWith("`") ||
    (raw.startsWith(" ") && raw.endsWith(" ") && /[^ ]/.test(raw));
  return `${fence}${pad ? ` ${raw} ` : raw}${fence}`;
}

function inlineMarkdown(node: JSONContent): string {
  if (node.type === "hardBreak") return "\n";
  const children = node.text === undefined ? (node.content ?? []) : [node];
  let result = "";
  let index = 0;
  while (index < children.length) {
    let sharedMark: RichTextMark | undefined;
    let end = index;
    // The longest shared emphasis stays outside shorter styles and code spans.
    for (const type of ["strike", "bold", "italic"] as const) {
      let next = index;
      while (
        next < children.length &&
        children[next]!.type !== "hardBreak" &&
        children[next]!.marks?.some((mark) => mark.type === type)
      )
        next++;
      if (next > end) {
        sharedMark = type;
        end = next;
      }
    }
    if (sharedMark) {
      const content = children.slice(index, end).map((child) => ({
        ...child,
        marks: (child.marks ?? []).filter((mark) => mark.type !== sharedMark),
      }));
      const marker = RICH_TEXT_DELIMITERS[sharedMark];
      result += marker + inlineMarkdown({ content }) + marker;
      index = end;
    } else {
      result += inlineText(children[index++]!);
    }
  }
  return result;
}

function isList(node: JSONContent): boolean {
  return ["bulletList", "orderedList", "taskList"].includes(node.type ?? "");
}

// Accumulate nested list output once; joining at each ancestor copies long leaves repeatedly.
function appendList(node: JSONContent, indent: string, parts: string[]): void {
  for (const [index, item] of (node.content ?? []).entries()) {
    if (index) parts.push("\n");
    const marker = node.type === "orderedList" ? `${Number(node.attrs?.start ?? 1) + index}.` : "-";
    const check = node.type === "taskList" ? `[${item.attrs?.checked ? "x" : " "}] ` : "";
    for (const [childIndex, child] of (item.content ?? []).entries()) {
      if (childIndex === 0) {
        parts.push(indent, marker, " ", check, inlineMarkdown(child));
      } else {
        parts.push("\n");
        const nestedIndent = `${indent}${" ".repeat(marker.length + 1)}`;
        if (isList(child)) appendList(child, nestedIndent, parts);
        else parts.push(serializeBlock(child, nestedIndent));
      }
    }
  }
}

function serializeBlock(node: JSONContent, indent = ""): string {
  const children = node.content ?? [];
  if (node.type === "noteRawMarkdown") return children.map((child) => child.text ?? "").join("");
  if (node.type === "heading")
    return `${"#".repeat(Number(node.attrs?.level ?? 1))} ${inlineMarkdown(node)}`;
  if (node.type === "horizontalRule") return "---";
  if (node.type === "codeBlock") {
    const value = children.map((child) => child.text ?? "").join("");
    const fence = "`".repeat(Math.max(2, longestBacktickRun(value)) + 1);
    return `${fence}${node.attrs?.language ?? ""}\n${value}\n${fence}`;
  }
  if (node.type === "blockquote")
    return children
      .map((child) =>
        serializeBlock(child)
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      )
      .join("\n> \n");
  if (isList(node)) {
    const parts: string[] = [];
    appendList(node, indent, parts);
    return parts.join("");
  }
  return inlineMarkdown(node)
    .replace(/^([ \t]*)([#>+-])(?=\s)/gm, "$1\\$2")
    .replace(/^(\d+)([.)])(?=\s)/gm, "$1\\$2");
}

// Unchanged blocks reuse their bytes; edits serialize only changed blocks in canonical form.
// The source fingerprint and surrounding whitespace survive editor transactions, with no reparse.
export function noteDocToMarkdown(doc: JSONContent): string {
  const blocks = doc.content ?? [];
  return blocks
    .map((node, index) => {
      const unchanged = node.attrs?.noteFingerprint === fingerprint(node);
      const source =
        unchanged && typeof node.attrs?.noteSource === "string"
          ? node.attrs.noteSource
          : serializeBlock(node);
      const suffix =
        typeof node.attrs?.noteSuffix === "string"
          ? node.attrs.noteSuffix
          : index < blocks.length - 1
            ? "\n\n"
            : "";
      return (
        (node.attrs?.notePrefix ?? "") +
        source +
        // Parser-owned source can include the boundary newline even with an empty suffix.
        (index < blocks.length - 1 && !suffix && !source.endsWith("\n") ? "\n\n" : suffix)
      );
    })
    .join("");
}
