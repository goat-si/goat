import { parseMarkdownDocument, type MarkdownNode } from "./markdownDocument";

export function markdownImageSources(markdown: string): string[] {
  if (!markdown.includes("![") && !/<img[\s>]/i.test(markdown)) return [];
  const root = parseMarkdownDocument(markdown);
  const definitions = new Map<string, string>();
  const collect = (node: MarkdownNode) => {
    if (node.type === "definition") {
      const identifier = node.identifier.toUpperCase();
      if (!definitions.has(identifier)) definitions.set(identifier, node.url);
    }
    if ("children" in node) node.children.forEach(collect);
  };
  collect(root);
  const sources = new Set<string>();
  const visit = (node: MarkdownNode) => {
    if (node.type === "image") sources.add(node.url);
    if (node.type === "imageReference") {
      const url = definitions.get(node.identifier.toUpperCase());
      if (url !== undefined) sources.add(url);
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(root);
  return [...sources];
}
