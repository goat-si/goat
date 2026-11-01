import remarkParse from "remark-parse";
import { unified } from "unified";

type MarkdownNode = {
  readonly type: string;
  readonly url?: string;
  readonly identifier?: string;
  readonly children?: ReadonlyArray<MarkdownNode>;
};

const parser = unified().use(remarkParse).freeze();

/**
 * Hrefs of the images a Markdown document actually renders, including reference images.
 * Image syntax inside code spans and code blocks is not an image and is skipped.
 */
export function markdownImageHrefs(markdown: string): ReadonlyArray<string> {
  const definitions = new Map<string, string>();
  const images: MarkdownNode[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "definition" && node.identifier && node.url) {
      // CommonMark uses the first definition for a reference label.
      if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    } else if (node.type === "image" || node.type === "imageReference") {
      images.push(node);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(parser.parse(markdown) as MarkdownNode);
  return images.flatMap((image) => {
    const href = image.url ?? definitions.get(image.identifier ?? "");
    return href === undefined ? [] : [href];
  });
}
