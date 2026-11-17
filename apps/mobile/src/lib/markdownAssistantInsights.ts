import { rewriteAssistantInsights } from "@goat/shared/markdownAssistantInsights";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * Claude's `★ Insight ───` blocks as a quote headed by their label, as web shows them. The
 * native renderer labels GitHub alerts by type only, so a labelled quote is the closest match.
 */
export function markdownWithAssistantInsights(markdown: string): string {
  if (!markdown.includes("★ Insight")) return markdown;
  const rewritten = rewriteAssistantInsights(markdown, parser.parse(markdown));
  if (rewritten === null) return markdown;
  return rewritten.lines
    .map((line, index) =>
      rewritten.starts.has(index + 1) ? `> **★ Insight**${line.slice(1)}` : line,
    )
    .join("");
}
