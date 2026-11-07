import type { JSONContent } from "@tiptap/core";
import { resolveNoteFilePath, type NoteEmbedSyntax } from "@goat/client-runtime/notes";
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
    ...["level", "checked", "start", "language", "syntax", "src", "text", "title"].map(
      (key) => node.attrs?.[key] ?? null,
    ),
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

const ATTACHMENT_REFERENCE = /(^|\/)\.attachments\/[0-9a-f]{16}\.[a-z0-9]{1,10}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

// A paragraph that is exactly one image, one web or attachment link, or one bare URL shows as an
// embed. Reference forms and anything mixed with other text stay as they are.
function embed(node: Paragraph, source: string, notePath?: string): JSONContent | null {
  const child = node.children.length === 1 ? node.children[0] : undefined;
  if (child?.type !== "image" && child?.type !== "link") return null;
  if (
    child.position?.start.offset !== node.position?.start.offset ||
    child.position?.end.offset !== node.position?.end.offset
  )
    return null;
  let syntax: NoteEmbedSyntax = "image";
  let label = "";
  // Only files the note can load become embeds; any other image or link stays editable text.
  const loadable =
    /^https?:\/\//i.test(child.url) ||
    (notePath === undefined
      ? ATTACHMENT_REFERENCE.test(child.url)
      : resolveNoteFilePath(notePath, child.url) !== null);
  if (!loadable) return null;
  if (child.type === "image") label = child.alt ?? "";
  else {
    const [only, ...rest] = child.children;
    if (rest.length > 0 || (only !== undefined && only.type !== "text")) return null;
    label = only?.value ?? "";
    syntax = source.startsWith("<") ? "autolink" : source.startsWith("[") ? "link" : "url";
  }
  const title = child.title ?? null;
  if ([child.url, label, title ?? ""].some((value) => CONTROL_CHARACTER.test(value))) return null;
  return { type: "noteEmbed", attrs: { syntax, src: child.url, text: label, title } };
}

// Every ASCII punctuation character may be backslash-escaped and parses back unchanged, which also
// keeps entity references, emphasis and brackets in names from turning into markup.
const escapePunctuation = (value: string) => value.replace(/[!-/:-@[-`{-~]/g, "\\$&");
// Labels, which people read, escape only what is markup inside link text.
const escapeLabel = (value: string) => value.replace(/[\\`*_[\]<>&!~|]/g, "\\$&");

function embedMarkdown(attrs: Record<string, unknown>): string {
  const src = typeof attrs.src === "string" ? attrs.src : "";
  const label = typeof attrs.text === "string" ? attrs.text : "";
  if (attrs.syntax === "url") return label || src;
  if (attrs.syntax === "autolink") return `<${src}>`;
  const destination = /^[\w/.~:?#=%+@,;-]+$/.test(src) ? src : `<${escapePunctuation(src)}>`;
  const title =
    typeof attrs.title === "string" && attrs.title ? ` "${escapePunctuation(attrs.title)}"` : "";
  return `${attrs.syntax === "image" ? "!" : ""}[${escapeLabel(label)}](${destination}${title})`;
}

// Embeds keep their source bytes while unchanged, so they load whenever writing them out again
// reads back as the same embed, even where the canonical spelling differs.
function sameEmbed(candidate: JSONContent, notePath?: string): boolean {
  if (candidate.type !== "noteEmbed") return false;
  const written = serializeBlock(candidate);
  const [paragraph, ...rest] = parser.parse(written).children;
  if (paragraph?.type !== "paragraph" || rest.length > 0) return false;
  return (
    JSON.stringify(embed(paragraph, written, notePath)?.attrs) === JSON.stringify(candidate.attrs)
  );
}

function block(
  source: string,
  node: RootContent,
  markdown: string,
  notePath?: string,
): JSONContent {
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
    return embed(node, source, notePath) ?? paragraph(node, markdown) ?? raw(source);
  }
  return raw(source);
}

// Called once when an editor document loads. Edits serialize the editor tree without parsing.
/** `notePath` lets attachment embeds load only when they resolve from that note. */
export function noteMarkdownToDoc(markdown: string, notePath?: string): JSONContent {
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
    const candidate = overlapping ? raw(source) : block(source, node, markdown, notePath);
    // Check the entire tree once: a noncanonical child keeps its containing block literal.
    const parsed =
      serializeBlock(candidate) === source || sameEmbed(candidate, notePath)
        ? candidate
        : raw(source);
    parsed.attrs = {
      ...parsed.attrs,
      notePrefix: content.length === 0 ? markdown.slice(0, start) : "",
      noteSource: source,
      noteFingerprint: fingerprint(parsed),
      noteSuffix: suffix,
    };
    content.push(parsed);
  }
  // Which block followed each one, so a separator is reused only beside that same neighbor.
  content.forEach((block, index) => {
    block.attrs = { ...block.attrs, noteNext: content[index + 1]?.attrs?.noteFingerprint ?? null };
  });
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
  if (node.type === "noteEmbed") return embedMarkdown(node.attrs ?? {});
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

// The type a block had when it loaded, which its stored fingerprint begins with.
function loadedType(node: JSONContent): unknown {
  const stored = node.attrs?.noteFingerprint;
  return typeof stored === "string" ? (JSON.parse(stored) as ReadonlyArray<unknown>)[0] : node.type;
}

// Loaded blocks carry the fingerprint they had; new ones are fingerprinted as they are.
function keepsSeparator(node: JSONContent, next: JSONContent): boolean {
  const nextIdentity =
    typeof next.attrs?.noteFingerprint === "string"
      ? next.attrs.noteFingerprint
      : fingerprint(next);
  return (
    nextIdentity === node.attrs?.noteNext &&
    loadedType(node) === node.type &&
    loadedType(next) === next.type
  );
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
      const next = blocks[index + 1];
      // A separator without a blank line was valid only for the pair it was written between; a
      // new, moved or retyped neighbor gets a blank line so the two never merge on reload.
      if (
        next !== undefined &&
        !/\n[ \t]*\n/.test((source.endsWith("\n") ? "\n" : "") + suffix) &&
        !keepsSeparator(node, next)
      )
        return (node.attrs?.notePrefix ?? "") + source + (source.endsWith("\n") ? "\n" : "\n\n");
      return (
        (node.attrs?.notePrefix ?? "") +
        source +
        // Parser-owned source can include the boundary newline even with an empty suffix.
        (index < blocks.length - 1 && !suffix && !source.endsWith("\n") ? "\n\n" : suffix)
      );
    })
    .join("");
}
