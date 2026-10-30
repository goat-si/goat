import type { RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse).use(remarkGfm);

// Nodes the native input renders as formatting; anything else would show as raw syntax.
const INLINE = new Set(["text", "strong", "emphasis", "delete", "link", "break"]);
const LABELS: Readonly<Record<string, string>> = {
  code: "a code block",
  inlineCode: "inline code",
  table: "a table",
  blockquote: "a quote",
  html: "HTML",
  thematicBreak: "a divider",
  image: "an image",
  imageReference: "an image",
  linkReference: "a reference link",
  definition: "a reference link",
  footnoteDefinition: "a footnote",
  footnoteReference: "a footnote",
};
const label = (type: string) => LABELS[type] ?? "content the visual editor cannot show";

// Where remark and the input's md4c read the same bytes differently: md4c parses `_x_` as
// underline and `||x||` as a spoiler, which remark keeps as emphasis and plain text.
function inlineBlocker(text: string, children: ReadonlyArray<RootContent>): string | null {
  for (const child of children) {
    if (!INLINE.has(child.type)) return label(child.type);
    if (child.type === "text" && child.value.includes("||")) return "a || marker";
    if (
      (child.type === "emphasis" || child.type === "strong") &&
      text[child.position?.start.offset ?? -1] === "_"
    )
      return "underscore formatting";
    // An edit inside such a range can move its closing marker onto the untouched line.
    if (
      child.type !== "text" &&
      child.type !== "break" &&
      text.slice(child.position?.start.offset, child.position?.end.offset).includes("\n")
    )
      return "formatting that spans lines";
    const found = "children" in child ? inlineBlocker(text, child.children) : null;
    if (found) return found;
  }
  return null;
}

function blockBlocker(text: string, node: RootContent, inList: boolean): string | null {
  if (node.type === "paragraph") return inlineBlocker(text, node.children);
  if (node.type === "heading")
    return inList ? "a heading in a list" : inlineBlocker(text, node.children);
  if (node.type !== "list") return label(node.type);
  if (node.spread) return "a list with blank lines between items";
  for (const item of node.children) {
    if (item.checked != null) return "a checklist";
    if (item.spread) return "a list with blank lines between items";
    const [first, ...nested] = item.children;
    if (!first) continue;
    if (first.type !== "paragraph") return label(first.type);
    // The input keeps one line per item; a continuation line would become a plain paragraph.
    if (text.slice(first.position?.start.offset, first.position?.end.offset).includes("\n"))
      return "a list item with several lines";
    if (nested.some((child) => child.type !== "list")) return "a list item with several paragraphs";
    for (const child of item.children) {
      const found = blockBlocker(text, child, true);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The first construct the native rich input would show as raw syntax, or null when it can show
 * the whole note. Byte preservation is a separate check against the native serializer.
 */
export function visualEditorBlocker(markdown: string): string | null {
  const crlf = markdown.includes("\r\n");
  if (/\r(?!\n)/.test(markdown) || (crlf && /(?<!\r)\n/.test(markdown)))
    return "mixed line endings";
  const text = crlf ? markdown.replaceAll("\r\n", "\n") : markdown;
  for (const node of parser.parse(text).children) {
    const found = blockBlocker(text, node, false);
    if (found) return found;
  }
  return null;
}

/** A note as the visual editor holds it, plus what writing it back needs. */
export interface VisualNoteSession {
  readonly source: string;
  readonly text: string;
  readonly crlf: boolean;
}

export function openVisualNote(source: string): VisualNoteSession {
  const crlf = source.includes("\r\n");
  return { source, text: crlf ? source.replaceAll("\r\n", "\n") : source, crlf };
}

/**
 * The body to save from the editor's markdown. An unchanged editor returns the original bytes,
 * and a CRLF note keeps CRLF on every line, including new ones.
 */
export function visualNoteBody(session: VisualNoteSession, edited: string): string {
  const text = edited.replace(/\r\n?/g, "\n");
  if (text === session.text) return session.source;
  return session.crlf ? text.replaceAll("\n", "\r\n") : text;
}
