import {
  goatBotChangeRequestLabel,
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

/**
 * Pull request links read as their short reference instead of their address, and a bare
 * reference links to the reply's one repository. Both stay ordinary links, so they keep the
 * host's icon and open the way every chat link does.
 */
function remarkGoatBotChangeRequests(options: {
  readonly repository: GoatBotReplyRepository | null;
}) {
  const visit = (node: MarkdownNode): void => {
    const children = node.children;
    if (children === undefined) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child === undefined) continue;
      if (child.type === "link") {
        const only = child.children?.length === 1 ? child.children[0] : undefined;
        // Only an address shown as itself is relabelled; a link the bot named keeps its words.
        if (only?.type === "text" && child.url !== undefined && only.value === child.url) {
          const label = goatBotChangeRequestLabel(child.url, options.repository);
          if (label !== null) only.value = label;
        }
        continue;
      }
      if (SKIPPED.has(child.type)) continue;
      if (child.type !== "text" || child.value === undefined || options.repository === null) {
        visit(child);
        continue;
      }
      const value = child.value;
      const links = options.repository.references(value);
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
  return (tree: MarkdownNode) => visit(tree);
}

const NO_REPOSITORY: PluggableList = [[remarkGoatBotChangeRequests, { repository: null }]];
const byRepository = new Map<string, PluggableList>();

/** One plugin list per repository, so replies share ChatMarkdown's parse cache. */
export function goatBotReplyMarkdownPlugins(
  repository: GoatBotReplyRepository | null,
): PluggableList {
  if (repository === null) return NO_REPOSITORY;
  let plugins = byRepository.get(repository.repositoryUrl);
  if (plugins === undefined) {
    plugins = [[remarkGoatBotChangeRequests, { repository }]];
    byRepository.set(repository.repositoryUrl, plugins);
  }
  return plugins;
}
