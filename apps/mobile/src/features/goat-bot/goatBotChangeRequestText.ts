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
// An inline HTML tag. Whatever an element holds stays as written: the renderer shows the markup
// itself, so a short label would change what the person reads.
const HTML_TAG = /<(\/)?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])[^>]*?(\/)?>/gu;
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** How many HTML elements are open after this inline HTML, from how many were open before. */
function openElements(html: string, before: number): number {
  let open = before;
  for (const match of html.matchAll(HTML_TAG)) {
    const [, closing, name = "", selfClosing] = match;
    if (closing) open = Math.max(0, open - 1);
    else if (!selfClosing && !VOID_TAGS.has(name.toLowerCase())) open += 1;
  }
  return open;
}

/** The reply's link nodes; an address quoted in code, Markdown or HTML, is never one. */
function linkNodes(node: MarkdownNode, into: MarkdownNode[] = []): MarkdownNode[] {
  let quoted = 0;
  for (const child of node.children ?? []) {
    if (child.type === "html") quoted = openElements(child.value ?? "", quoted);
    else if (quoted > 0) continue;
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

/** A link destination as Markdown, in angle brackets when its characters would end it early. */
function markdownDestination(url: string): string {
  return /[\s()<>\\]/u.test(url) ? `<${url.replace(/[<>\\]/gu, "\\$&")}>` : url;
}

/**
 * Pull request addresses read as "#7" (or "owner/repo#7") and a bare "#8" linked; named links keep
 * their words. A bare address stays the link's words with its label in `labels`, so a screen reader
 * hears both; it is written in only where the address also sits under the bot's own words.
 */
export function goatBotChangeRequestLinks(
  markdown: string,
  replyRepository?: GoatBotReplyRepository | null,
): { readonly markdown: string; readonly labels: ReadonlyMap<string, string> } {
  const labels = new Map<string, string>();
  if (!WEB_ADDRESS.test(markdown) && !replyRepository) return { markdown, labels };
  const links = linkNodes(parser.parse(markdown));
  const repository =
    replyRepository === undefined ? goatBotReplyRepository(linkUrls(links)) : replyRepository;
  const bare = (link: MarkdownNode) => {
    const only = link.children?.length === 1 ? link.children[0] : undefined;
    return link.url !== undefined && only?.type === "text" && only.value === link.url;
  };
  const named = new Set(links.flatMap((link) => (link.url && !bare(link) ? [link.url] : [])));
  const edits: { start: number; end: number; value: string }[] = [];
  for (const link of links) {
    const start = link.position?.start.offset;
    const end = link.position?.end.offset;
    if (link.url === undefined || !bare(link) || start === undefined || end === undefined) continue;
    const label = goatBotChangeRequestLabel(link.url, repository);
    if (label === null) continue;
    if (!named.has(link.url) && !/[\s<>]/u.test(link.url)) {
      // An autolink keeps the address as the link's words wherever the bot left it bare.
      labels.set(link.url, label);
      edits.push({ start, end, value: `<${link.url}>` });
    } else edits.push({ start, end, value: `[${label}](${markdownDestination(link.url)})` });
  }
  let relabelled = markdown;
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index];
    if (edit === undefined) continue;
    relabelled = relabelled.slice(0, edit.start) + edit.value + relabelled.slice(edit.end);
  }
  return {
    markdown:
      repository === null ? relabelled : linkReferenceAutolinks(relabelled, repository.references),
    labels,
  };
}

/**
 * Where the text quotes code or markup (backticks, fences, indented code, HTML elements): addresses
 * there stay as written.
 */
function quotedRanges(text: string): ReadonlyArray<readonly [number, number]> {
  if (!/`|~~~|<[A-Za-z]|(?:^|\n)(?: {4}|\t)/u.test(text)) return [];
  const ranges: Array<readonly [number, number]> = [];
  const visit = (node: MarkdownNode) => {
    let open = 0;
    let from = 0;
    for (const child of node.children ?? []) {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      if (child.type === "inlineCode" || child.type === "code") ranges.push([start, end]);
      else if (child.type === "html") {
        const next = openElements(child.value ?? "", open);
        if (open === 0 && next > 0) from = start;
        else if (open > 0 && next === 0) ranges.push([from, end]);
        open = next;
      } else if (open === 0) visit(child);
    }
    if (open > 0) ranges.push([from, text.length]);
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
