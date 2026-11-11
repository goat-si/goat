import {
  goatBotChangeRequestLabel,
  goatBotReplyRepository,
  type GoatBotTextPart,
} from "@goat/client-runtime/goatBot";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { linkReferenceAutolinks } from "../pull-requests/pullRequestAutolinks";

type MarkdownNode = {
  readonly type: string;
  readonly url?: string;
  readonly value?: string;
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
  readonly children?: readonly MarkdownNode[] | undefined;
};

const parser = unified().use(remarkParse).use(remarkGfm);
const WEB_ADDRESS = /https?:\/\//iu;
// Text inside these is never a link the person sees.
const NOT_PROSE = new Set(["inlineCode", "code", "html", "definition"]);

/** The reply's link nodes; an address quoted in code is never one. */
function linkNodes(node: MarkdownNode, into: MarkdownNode[] = []): MarkdownNode[] {
  for (const child of node.children ?? []) {
    if (child.type === "link") into.push(child);
    else if (!NOT_PROSE.has(child.type)) linkNodes(child, into);
  }
  return into;
}

/**
 * Bot Markdown with its pull request links reading as short references, as on web: a link shown
 * as its own address becomes "#7" in the reply's one repository, else "owner/repo#7", and a bare
 * "#8" links to that repository. Edits follow the parser's positions, since the native renderer
 * takes Markdown text; a link the bot named keeps its words.
 */
export function goatBotChangeRequestMarkdown(markdown: string): string {
  if (!WEB_ADDRESS.test(markdown)) return markdown;
  const links = linkNodes(parser.parse(markdown));
  const repository = goatBotReplyRepository(links.flatMap((link) => (link.url ? [link.url] : [])));
  const edits: { start: number; end: number; value: string }[] = [];
  for (const link of links) {
    const only = link.children?.length === 1 ? link.children[0] : undefined;
    const start = link.position?.start.offset;
    const end = link.position?.end.offset;
    if (link.url === undefined || only?.type !== "text" || only.value !== link.url) continue;
    if (start === undefined || end === undefined) continue;
    const label = goatBotChangeRequestLabel(link.url, repository);
    if (label !== null) edits.push({ start, end, value: `[${label}](${link.url})` });
  }
  let relabelled = markdown;
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index];
    if (edit === undefined) continue;
    relabelled = relabelled.slice(0, edit.start) + edit.value + relabelled.slice(edit.end);
  }
  return repository === null
    ? relabelled
    : linkReferenceAutolinks(relabelled, repository.references);
}

/** The same for plain bot text already split into words and addresses. */
export function goatBotChangeRequestParts(
  parts: ReadonlyArray<GoatBotTextPart>,
): ReadonlyArray<GoatBotTextPart> {
  const repository = goatBotReplyRepository(
    parts.flatMap((part) => (part.kind === "link" ? [part.url] : [])),
  );
  return parts.flatMap((part): GoatBotTextPart[] => {
    if (part.kind === "link") {
      const label = goatBotChangeRequestLabel(part.url, repository);
      return [label === null ? part : { ...part, text: label }];
    }
    if (repository === null) return [part];
    const found = repository.references(part.text);
    if (found.length === 0) return [part];
    const split: GoatBotTextPart[] = [];
    let cursor = 0;
    for (const link of found) {
      if (link.index > cursor)
        split.push({ kind: "text", text: part.text.slice(cursor, link.index) });
      split.push({ kind: "link", text: link.label, url: link.url });
      cursor = link.index + link.text.length;
    }
    if (cursor < part.text.length) split.push({ kind: "text", text: part.text.slice(cursor) });
    return split;
  });
}
