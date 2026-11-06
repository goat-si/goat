import type { Tree } from "@lezer/common";

/** CommonMark matches reference labels case-insensitively with collapsed whitespace. */
export const normalizeLinkLabel = (label: string) =>
  label.trim().replace(/\s+/g, " ").toLowerCase();

const PLAYABLE = /\.(?:mp4|webm|mov|m4v|mp3|wav|ogg|m4a)$/i;

/**
 * Video and audio embedded with image syntax, which phones cannot draw inline. They show as a
 * label that opens the file instead; null for anything else.
 */
export function playableMediaLabel(href: string, alt: string): string | null {
  const path = href.replace(/[?#].*$/, "");
  if (!PLAYABLE.test(path)) return null;
  return `▶ ${alt.trim() || path.slice(path.lastIndexOf("/") + 1)}`;
}

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
