import type { Tree } from "@lezer/common";

/** CommonMark matches reference labels case-insensitively with collapsed whitespace. */
export const normalizeLinkLabel = (label: string) =>
  label.trim().replace(/\s+/g, " ").toLowerCase();

// Definitions sit at block level, possibly inside quotes and list items; nothing else holds one.
const containers = new Set(["Document", "Blockquote", "BulletList", "OrderedList", "ListItem"]);

/** Link reference definitions the parser recognized; the first definition of a label wins. */
export function noteLinkDefinitions(
  tree: Tree,
  read: (from: number, to: number) => string,
): ReadonlyMap<string, string> {
  const definitions = new Map<string, string>();
  const cursor = tree.cursor();
  const visit = (): void => {
    if (cursor.name === "LinkReference") {
      const node = cursor.node;
      const label = node.getChild("LinkLabel");
      const url = node.getChild("URL");
      if (label && url) {
        const name = normalizeLinkLabel(read(label.from + 1, label.to - 1));
        const href = read(url.from, url.to).replace(/^<(.*)>$/, "$1");
        if (name && !name.startsWith("^") && !definitions.has(name)) definitions.set(name, href);
      }
      return;
    }
    if (!containers.has(cursor.name) || !cursor.firstChild()) return;
    do visit();
    while (cursor.nextSibling());
    cursor.parent();
  };
  visit();
  return definitions;
}
