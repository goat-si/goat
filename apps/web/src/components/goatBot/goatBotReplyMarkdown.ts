import {
  goatBotChangeRequestLabel,
  goatBotReplyRepository,
  type GoatBotReplyRepository,
} from "@goat/client-runtime/goatBot";
import type { PluggableList } from "unified";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

const SKIPPED = new Set(["link", "linkReference", "inlineCode", "code"]);

/** The addresses of the reply's links; text inside code is never a link node. */
function linkUrls(node: MarkdownNode, into: string[] = []): string[] {
  for (const child of node.children ?? []) {
    if (child.type === "link" && child.url !== undefined) into.push(child.url);
    else if (child.type !== "inlineCode" && child.type !== "code") linkUrls(child, into);
  }
  return into;
}

/**
 * Pull request links read as their short reference instead of their address, and a bare
 * reference links to the reply's one repository. Both stay ordinary links, so they keep the
 * host's icon and open the way every chat link does.
 */
function remarkGoatBotChangeRequests(options?: { readonly replyLinkUrls?: ReadonlyArray<string> }) {
  const visit = (node: MarkdownNode, repository: GoatBotReplyRepository | null): void => {
    const children = node.children;
    if (children === undefined) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child === undefined) continue;
      if (child.type === "link") {
        const only = child.children?.length === 1 ? child.children[0] : undefined;
        // Only an address shown as itself is relabelled; a link the bot named keeps its words.
        if (only?.type === "text" && child.url !== undefined && only.value === child.url) {
          const label = goatBotChangeRequestLabel(child.url, repository);
          if (label !== null) only.value = label;
        }
        continue;
      }
      if (SKIPPED.has(child.type)) continue;
      if (child.type !== "text" || child.value === undefined || repository === null) {
        visit(child, repository);
        continue;
      }
      const value = child.value;
      const links = repository.references(value);
      if (links.length === 0) continue;
      const replacements: MarkdownNode[] = [];
      let start = 0;
      for (const link of links) {
        if (start < link.index)
          replacements.push({ type: "text", value: value.slice(start, link.index) });
        replacements.push({
          type: "link",
          url: link.url,
          children: [{ type: "text", value: link.label }],
        });
        start = link.index + link.text.length;
      }
      if (start < value.length) replacements.push({ type: "text", value: value.slice(start) });
      children.splice(index, 1, ...replacements);
      index += replacements.length - 1;
    }
  };
  return (tree: MarkdownNode) =>
    visit(tree, goatBotReplyRepository(options?.replyLinkUrls ?? linkUrls(tree)));
}

/** One shared plugin list, so replies share ChatMarkdown's parse cache. */
export const GOAT_BOT_REPLY_MARKDOWN_PLUGINS: PluggableList = [remarkGoatBotChangeRequests];

const MAX_REPLY_CONTEXTS = 64;
const contextPlugins = new Map<string, PluggableList>();

/**
 * The plugins for one card of a reply split across cards: bare references read against the whole
 * reply's links. Cards of the same reply share one list, which keeps ChatMarkdown's cache.
 */
export function goatBotReplyMarkdownPlugins(replyLinkUrls: ReadonlyArray<string>): PluggableList {
  const key = replyLinkUrls.join("\n");
  const known = contextPlugins.get(key);
  if (known !== undefined) return known;
  const plugins: PluggableList = [[remarkGoatBotChangeRequests, { replyLinkUrls }]];
  contextPlugins.set(key, plugins);
  if (contextPlugins.size > MAX_REPLY_CONTEXTS) {
    const oldest = contextPlugins.keys().next().value;
    if (oldest !== undefined) contextPlugins.delete(oldest);
  }
  return plugins;
}
