/**
 * A message as the one plain line a conversation list shows: Markdown marks go, the words stay.
 * This is a reading aid for a preview, not a Markdown parser; odd input degrades to its text.
 */
export function goatBotPreviewText(markdown: string): string {
  const lines = markdown.split(/\r?\n/).flatMap((line) => {
    const text = line.trim();
    // Fences, rules and table separator rows carry no words.
    if (/^(```|~~~)/.test(text) || /^([-*_])(\s*\1){2,}$/.test(text)) return [];
    if (/^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{0,}:?\s*\|?$/.test(text)) return [];
    return [
      text
        .replace(/^(>\s*)+/, "")
        .replace(/^#{1,6}\s+/, "")
        .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
        .replace(/^\||\|$/g, "")
        .replace(/\s*\|\s*/g, " "),
    ];
  });
  return lines
    .join(" ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/(`+)([^`]+?)\1/g, "$2")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/(^|[^\w*\\])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w\\])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
