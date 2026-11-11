import type { Parent, Root, RootContent } from "mdast";

/**
 * A file's preview loads nothing the file names: an image or media becomes its alt text, a link
 * its words (no favicon), and raw HTML is dropped. Opening the file shows it in full.
 */
function withoutExternalMedia(node: Parent) {
  node.children = node.children.flatMap((child): RootContent[] => {
    if (child.type === "image" || child.type === "imageReference")
      return child.alt ? [{ type: "text" as const, value: child.alt }] : [];
    if (child.type === "html") return [];
    if ("children" in child) withoutExternalMedia(child);
    if (child.type === "link" || child.type === "linkReference") return child.children;
    return [child];
  });
}

/** One module-level list: ChatMarkdown keys its parse cache by it. */
export const GOAT_BOT_PREVIEW_REMARK_PLUGINS = [
  () => (tree: Root) => {
    withoutExternalMedia(tree);
  },
];
