/** CommonMark matches reference labels case-insensitively with collapsed whitespace. */
export const normalizeLinkLabel = (label: string) =>
  label.trim().replace(/\s+/g, " ").toLowerCase();

const definitionPattern = /^ {0,3}\[((?:[^\]\\\n]|\\.){1,999})\]:[ \t]*(?:<([^>\n]*)>|(\S+))/gm;

/** Link reference definitions in a note; the first definition of a label wins. */
export function noteLinkDefinitions(text: string): ReadonlyMap<string, string> {
  const definitions = new Map<string, string>();
  for (const match of text.matchAll(definitionPattern)) {
    const label = normalizeLinkLabel(match[1] ?? "");
    const href = match[2] ?? match[3];
    if (label && !label.startsWith("^") && href && !definitions.has(label))
      definitions.set(label, href);
  }
  return definitions;
}
