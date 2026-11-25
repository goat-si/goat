import type { AssistantCitation } from "@goat/contracts";
import { collectAssistantCitations } from "@goat/shared/assistantCitations";
import {
  collectComposerContextReferences,
  isAttachmentOnlyBootstrapPrompt,
} from "@goat/shared/composerContextReferences";
import type { Nodes } from "mdast";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role !== "user") {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userText: isAttachmentOnlyBootstrapPrompt(row.message.text) ? "" : row.message.text,
      assistantText: resolveFinalAssistantTextForTurn(rows, index),
    });
  }
  return items;
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

const markdownPreviewParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkCjkFriendly)
  .freeze();
const userMarkdownPreviewParser = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkCjkFriendly)
  .freeze();

const INLINE_PARENT_TYPES = new Set<Nodes["type"]>([
  "paragraph",
  "heading",
  "tableCell",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
]);

function markdownNodeText(node: Nodes, userMessage = false): string {
  if (node.type === "html") {
    if (userMessage) return node.value;
    return node.value
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      .replace(/<\/?([a-z][\w-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (_, tag: string) =>
        /^(?:address|article|aside|blockquote|br|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|th|thead|tr|ul)$/i.test(
          tag,
        )
          ? " "
          : "",
      );
  }
  if (node.type === "break") return " ";
  if ("value" in node) return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (!("children" in node)) return "";
  const separator = INLINE_PARENT_TYPES.has(node.type) ? "" : " ";
  return node.children.map((child) => markdownNodeText(child, userMessage)).join(separator);
}

/** Markdown as one line of the text it renders, without markup or link targets. */
export function markdownPlainText(markdown: string): string {
  return markdownNodeText(markdownPreviewParser.parse(markdown)).replace(/\s+/g, " ").trim();
}

const MINIMAP_PREFIX_LENGTH = 1_500;

export function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const high = text.charCodeAt(index - 1);
  const low = text.charCodeAt(index);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

function markdownMinimapPreview(markdown: string | null) {
  // The tooltip only shows a few lines, including while assistant text is streaming.
  if (markdown === null) return null;
  const end = splitsSurrogatePair(markdown, MINIMAP_PREFIX_LENGTH)
    ? MINIMAP_PREFIX_LENGTH - 1
    : MINIMAP_PREFIX_LENGTH;
  return markdownPlainText(markdown.slice(0, end)) || null;
}

function sliceCitationText(text: string, limit: number): string {
  const lastCodePoint = text.codePointAt(limit - 1) ?? 0;
  return text.slice(0, lastCodePoint > 0xffff ? limit - 1 : limit);
}

function citationPreviewLabel(citation: AssistantCitation, limit: number): string {
  const quote = sliceCitationText(citation.text, limit);
  const commentPrefix = " Comment: ";
  const remaining = limit - quote.length - commentPrefix.length;
  return citation.comment === undefined || remaining <= 0
    ? quote
    : quote + commentPrefix + sliceCitationText(citation.comment, remaining);
}

function expandUserPreviewTokens(markdown: string) {
  const tokens = [
    ...collectComposerContextReferences(markdown, MINIMAP_PREFIX_LENGTH).map(
      ({ start, end, label }) => ({
        start,
        end,
        label,
      }),
    ),
    ...collectAssistantCitations(markdown, MINIMAP_PREFIX_LENGTH),
  ].sort((a, b) => a.start - b.start);
  let expanded = "";
  let offset = 0;
  for (const token of tokens) {
    const { start, end } = token;
    if (start < offset) continue;
    expanded += markdown.slice(offset, start);
    const label =
      "citation" in token
        ? citationPreviewLabel(token.citation, Math.max(0, MINIMAP_PREFIX_LENGTH - expanded.length))
        : token.label;
    const literal = label.replace(/\s+/g, " ").replace(/[!-\/:-@[-`{-~]/g, "\\$&");
    expanded += literal;
    offset = end;
  }
  return expanded + markdown.slice(offset, MINIMAP_PREFIX_LENGTH);
}

function userMinimapPreview(markdown: string | null) {
  if (markdown === null) return null;
  const expanded = expandUserPreviewTokens(markdown);
  return (
    markdownNodeText(userMarkdownPreviewParser.parse(expanded), true).replace(/\s+/g, " ").trim() ||
    null
  );
}

export function resolveTimelineMinimapPreview(
  item: TimelineMinimapItem | null,
): TimelineMinimapItem | null {
  return item === null
    ? null
    : {
        ...item,
        userText: userMinimapPreview(item.userText),
        assistantText: markdownMinimapPreview(item.assistantText),
      };
}
