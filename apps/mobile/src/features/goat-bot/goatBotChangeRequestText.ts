import {
  goatBotChangeRequestLabel,
  goatBotReplyRepository,
  type GoatBotReplyRepository,
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
// Inline HTML that quotes its contents rather than linking them.
const QUOTING_TAG = /<(\/)?(?:a|code|pre|script|style)(?=[\s>])[^>]*>/giu;

/** The reply's link nodes; an address quoted in code, Markdown or HTML, is never one. */
function linkNodes(node: MarkdownNode, into: MarkdownNode[] = []): MarkdownNode[] {
  let quoted = 0;
  for (const child of node.children ?? []) {
    if (child.type === "html") {
      for (const match of (child.value ?? "").matchAll(QUOTING_TAG))
        quoted = Math.max(0, quoted + (match[1] ? -1 : 1));
    } else if (quoted > 0) continue;
    else if (child.type === "link") into.push(child);
    else if (!NOT_PROSE.has(child.type)) linkNodes(child, into);
  }
  return into;
}

function linkUrls(links: readonly MarkdownNode[]): string[] {
  return links.flatMap((link) => (link.url ? [link.url] : []));
}

/**
 * The one repository a whole reply's pull request links name, or null when they name none or
 * several. Cards of the same reply share it, so a table's links count with the prose around it.
 */
export function goatBotChangeRequestContext(markdown: string): GoatBotReplyRepository | null {
  if (!WEB_ADDRESS.test(markdown)) return null;
  return goatBotReplyRepository(linkUrls(linkNodes(parser.parse(markdown))));
}

/**
 * Bot Markdown with pull request addresses read as "#7" in the reply's one repository, else
 * "owner/repo#7", and a bare "#8" linked there; a link the bot named keeps its words. One card of
 * a reply passes the whole reply's repository. Edits follow parser positions: the renderer takes
 * Markdown text.
 */
export function goatBotChangeRequestMarkdown(
  markdown: string,
  replyRepository?: GoatBotReplyRepository | null,
): string {
  if (!WEB_ADDRESS.test(markdown) && !replyRepository) return markdown;
  const links = linkNodes(parser.parse(markdown));
  const repository =
    replyRepository === undefined ? goatBotReplyRepository(linkUrls(links)) : replyRepository;
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

/** Where the text quotes code (backticks, fences, HTML code): addresses there stay as written. */
function quotedRanges(text: string): ReadonlyArray<readonly [number, number]> {
  if (!/`|~~~|<(?:code|pre)/iu.test(text)) return [];
  const ranges: Array<readonly [number, number]> = [];
  const visit = (node: MarkdownNode) => {
    let open: number | null = null;
    for (const child of node.children ?? []) {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      if (child.type === "inlineCode" || child.type === "code") ranges.push([start, end]);
      else if (child.type === "html") {
        for (const match of (child.value ?? "").matchAll(QUOTING_TAG)) {
          if (!match[1] && open === null) open = start;
          else if (match[1] && open !== null) {
            ranges.push([open, end]);
            open = null;
          }
        }
      } else visit(child);
    }
    if (open !== null) ranges.push([open, text.length]);
  };
  visit(parser.parse(text));
  return ranges;
}

/**
 * The same for plain bot text already split into words and addresses. Given the text the parts
 * came from, anything it quotes as code keeps its addresses and numbers as written; given the
 * whole reply's repository, this text is read as one card of that reply.
 */
export function goatBotChangeRequestParts(
  parts: ReadonlyArray<GoatBotTextPart>,
  text?: string,
  replyRepository?: GoatBotReplyRepository | null,
): ReadonlyArray<GoatBotTextPart> {
  const quoted = text === undefined ? [] : quotedRanges(text);
  const isQuoted = (start: number, end: number) =>
    quoted.some(([from, to]) => start < to && end > from);
  // Each part with where it sits, and stretches of words split at the quoted edges.
  const placed: Array<{ part: GoatBotTextPart; quoted: boolean }> = [];
  let offset = 0;
  for (const part of parts) {
    const start = offset;
    offset += part.text.length;
    if (part.kind === "link" || quoted.length === 0) {
      placed.push({ part, quoted: isQuoted(start, offset) });
      continue;
    }
    const cuts = [
      ...new Set(
        quoted
          .flat()
          .filter((cut) => cut > start && cut < offset)
          .map((cut) => cut - start),
      ),
    ].sort((a, b) => a - b);
    let from = 0;
    for (const cut of [...cuts, part.text.length]) {
      if (cut > from)
        placed.push({
          part: { kind: "text", text: part.text.slice(from, cut) },
          quoted: isQuoted(start + from, start + cut),
        });
      from = cut;
    }
  }
  const repository =
    replyRepository !== undefined
      ? replyRepository
      : goatBotReplyRepository(
          placed.flatMap(({ part, quoted: inCode }) =>
            part.kind === "link" && !inCode ? [part.url] : [],
          ),
        );
  return placed.flatMap(({ part, quoted: inCode }): GoatBotTextPart[] => {
    if (inCode) return [part];
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
