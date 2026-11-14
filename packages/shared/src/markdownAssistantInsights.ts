import type { PhrasingContent, Root, RootContent } from "mdast";
import type { Processor } from "unified";

export function remarkAssistantInsights(this: Processor) {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    if (!source.includes("★ Insight")) return;
    const protectedRanges: { start: number; end: number; code: boolean }[] = [];
    const inspect = (node: RootContent | PhrasingContent) => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        const code =
          node.type === "code" ||
          node.type === "html" ||
          (node.type === "inlineCode" && node.position?.start.line !== node.position?.end.line);
        if (code || node.type === "list" || node.type === "blockquote")
          protectedRanges.push({ start, end, code });
      }
      if ("children" in node) node.children.forEach(inspect);
    };
    tree.children.forEach(inspect);
    const starts = new Set<number>();
    const offsets: { original: number; rewritten: number; prefix: number }[] = [];
    let indent: string | undefined;
    let original = 0;
    let rewritten = 0;
    const lines = source.split(/(?<=\n)|(?<=\r)(?!\n)/u).map((line, index) => {
      const value = line.replace(/[\r\n]+$/u, "");
      const blocked = protectedRanges.some(
        (range) =>
          original >= range.start && original < range.end && (indent === undefined || range.code),
      );
      const opening =
        indent === undefined && !blocked
          ? /^( {0,3})(`?)★ Insight[ \t]+─{3,}\2[ \t]*$/u.exec(value)
          : null;
      const closing =
        indent !== undefined && !blocked ? /^( {0,3})(`?)─{3,}\2[ \t]*$/u.exec(value) : null;
      let prefix = 0;
      let output = line;
      if (opening) {
        indent = opening[1] ?? "";
        starts.add(index + 1);
        output = ">" + line.slice(value.length);
      } else if (closing && closing[1] === indent) {
        indent = undefined;
        output = line.slice(value.length);
      } else if (indent !== undefined) {
        prefix = 2;
        output = "> " + line;
      }
      offsets.push({ original, rewritten, prefix });
      original += line.length;
      rewritten += output.length;
      return output;
    });
    if (starts.size === 0) return;
    const parsed = this.parse(lines.join("")) as Root;
    const restorePosition = (node: RootContent | PhrasingContent) => {
      if (node.position) {
        for (const point of [node.position.start, node.position.end]) {
          const offset = offsets[point.line - 1];
          if (!offset) continue;
          point.column = Math.max(1, point.column - offset.prefix);
          if (point.offset !== undefined)
            point.offset += offset.original - offset.rewritten - offset.prefix;
        }
      }
      if ("children" in node) node.children.forEach(restorePosition);
    };
    for (const node of parsed.children) {
      if (node.type === "blockquote" && starts.has(node.position?.start.line ?? 0)) {
        node.data = { ...node.data, hProperties: { dataAlert: "insight" } };
      }
      restorePosition(node);
    }
    tree.children = parsed.children;
  };
}
