import { hasThreadLinks, parseThreadLinkHref } from "@goat/shared/threadLinks";

const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;

/**
 * Bot Markdown without links to GOAT threads: a thread link keeps its words and loses the link, since
 * the threads a bot starts are reached from its home, not from the conversation. Web, pull request
 * and file links stay. Code spans and fenced blocks are left exactly as written.
 */
export function goatBotWithoutThreadLinks(markdown: string): string {
  if (!hasThreadLinks(markdown)) return markdown;
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const opener = FENCE.exec(line)?.[1];
      if (fence !== null) {
        if (opener !== undefined && opener[0] === fence[0] && opener.length >= fence.length)
          fence = null;
        return line;
      }
      if (opener !== undefined) {
        fence = opener;
        return line;
      }
      return stripLine(line);
    })
    .join("\n");
}

function stripLine(line: string): string {
  let out = "";
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === "`") {
      // A code span runs to the next run of the same number of backticks.
      let ticks = 1;
      while (line[index + ticks] === "`") ticks += 1;
      const close = line.indexOf("`".repeat(ticks), index + ticks);
      const end = close === -1 ? index + ticks : close + ticks;
      out += line.slice(index, end);
      index = end;
      continue;
    }
    if (char === "[") {
      const link = readLink(line, index);
      if (link !== null) {
        out += parseThreadLinkHref(link.href) === null ? line.slice(index, link.end) : link.label;
        index = link.end;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

/** `[label](href)` starting at `start`, with balanced brackets in the label; null otherwise. */
function readLink(
  line: string,
  start: number,
): { readonly label: string; readonly href: string; readonly end: number } | null {
  let depth = 0;
  let index = start;
  for (; index < line.length; index += 1) {
    if (line[index] === "\\") {
      index += 1;
      continue;
    }
    if (line[index] === "[") depth += 1;
    else if (line[index] === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || line[index + 1] !== "(") return null;
  const close = line.indexOf(")", index + 2);
  if (close === -1) return null;
  const target = line.slice(index + 2, close).trim();
  const href = target.startsWith("<")
    ? target.slice(1, target.indexOf(">") === -1 ? undefined : target.indexOf(">"))
    : (target.split(/\s+/u)[0] ?? "");
  return { label: line.slice(start + 1, index), href, end: close + 1 };
}
