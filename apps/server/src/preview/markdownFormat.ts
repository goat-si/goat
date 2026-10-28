export const MARKDOWN_FORMAT = `(() => {
    const blocks = new Set([
      "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "ul", "ol",
      "table", "tr", "blockquote", "figure", "figcaption", "dl", "dt", "dd", "form", "fieldset",
      "details", "summary", "address", "hr",
    ]);
    return (node, inner, markdown, hrefOf) => {
      const tag = node.localName;
      if (/^h[1-6]$/.test(tag)) {
        const title = inner.trim();
        if (!title) return "";
        return "\\n\\n" + (markdown ? "#".repeat(Number(tag[1])) + " " : "") + title + "\\n\\n";
      }
      if (tag === "li") return "\\n" + (markdown ? "- " : "") + inner.trim() + "\\n";
      if (tag === "td" || tag === "th") return inner.trim() + " ";
      if (tag === "a" && markdown) {
        const label = inner.trim().replace(/[[\\]]/g, "");
        const href = hrefOf(node).replaceAll("(", "%28").replaceAll(")", "%29");
        return label && href ? "[" + label + "](" + href + ")" : inner;
      }
      return blocks.has(tag) ? "\\n\\n" + inner + "\\n\\n" : inner;
    };
})()`;

/** Trims lines and blank runs; leaves code fences exactly as the page had them. */
export const normalizeText = (text: string) => {
  let fenced = false;
  const lines: Array<string> = [];
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (line.trimStart().startsWith("~~~")) fenced = !fenced;
    lines.push(fenced ? line.trimEnd() : line.trim());
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};
