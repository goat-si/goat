import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";

interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  readonly children?: ReadonlyArray<MarkdownNode>;
}

const parser = unified().use(remarkParse).use(remarkGfm);

/** Paragraphs and headings carry the prose a reader sees; code and raw HTML do not. */
const PROSE_BLOCKS = new Set(["paragraph", "heading"]);

/** The rendered text of an inline run: emphasis and links unwrap, inline code keeps its text. */
function inlineText(node: MarkdownNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
  if (node.type === "break") return "\n";
  if (node.type === "html" || node.type === "image" || node.type === "footnoteReference") return "";
  return (node.children ?? []).map(inlineText).join("");
}

function collect(node: MarkdownNode, lines: Array<string>): void {
  if (PROSE_BLOCKS.has(node.type)) {
    for (const line of inlineText(node).split("\n")) lines.push(line.trim());
    return;
  }
  for (const child of node.children ?? []) collect(child, lines);
}

/**
 * The lines of prose a reader sees in GitHub-flavored Markdown, from paragraphs and headings at
 * any depth of blockquotes and lists. Fenced and indented code, HTML comments, and Markdown
 * syntax itself are left out, so a line can be tested for what it starts with.
 */
export function markdownTextLines(markdown: string): ReadonlyArray<string> {
  const lines: Array<string> = [];
  collect(parser.parse(markdown) as MarkdownNode, lines);
  return lines;
}
