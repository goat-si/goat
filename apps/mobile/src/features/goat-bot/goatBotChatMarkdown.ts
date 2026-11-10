import type { ThreadId } from "@goat/contracts";
import {
  hasThreadLinks,
  parseThreadLinkHref,
  percentDecodedThreadLinkId,
} from "@goat/shared/threadLinks";

const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;

/**
 * Bot Markdown without links to the threads its home lists: such a link keeps its words and loses
 * the link, since those threads open from the home. Links to any other thread, and web, pull
 * request and file links, stay. Code spans and fenced blocks are left exactly as written.
 */
export function goatBotWithoutThreadLinks(markdown: string, listed: ReadonlySet<ThreadId>): string {
  if (listed.size === 0) return markdown;
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
      return stripLine(line, listed);
    })
    .join("\n");
}

function listedThread(href: string, listed: ReadonlySet<ThreadId>): boolean {
  const id = parseThreadLinkHref(href);
  if (id === null) return false;
  const decoded = percentDecodedThreadLinkId(id);
  return listed.has(id) || (decoded !== null && listed.has(decoded));
}

function stripLine(line: string, listed: ReadonlySet<ThreadId>): string {
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
        out += listedThread(link.href, listed) ? link.label : line.slice(index, link.end);
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
  const target = readTarget(line, index + 2);
  return target === null ? null : { label: line.slice(start + 1, index), ...target };
}

const CLOSERS: Record<string, string> = { '"': '"', "'": "'", "(": ")" };

/**
 * An inline link's destination and optional title from `start` (just past "(") to its closing
 * ")": an angle-bracketed destination may hold parentheses and spaces, a bare one balanced
 * parentheses, and a title is quoted or parenthesised. Null when the link does not close.
 */
function readTarget(
  line: string,
  start: number,
): { readonly href: string; readonly end: number } | null {
  let index = start;
  const skipSpace = () => {
    while (line[index] === " " || line[index] === "\t") index += 1;
  };
  skipSpace();
  let href = "";
  if (line[index] === "<") {
    index += 1;
    for (; index < line.length && line[index] !== ">"; index += 1) {
      if (line[index] === "<") return null;
      if (line[index] === "\\") index += 1;
      href += line[index] ?? "";
    }
    if (line[index] !== ">") return null;
    index += 1;
  } else {
    let depth = 0;
    for (; index < line.length; index += 1) {
      const char = line[index];
      if (char === " " || char === "\t") break;
      if (char === "\\") {
        href += line[index + 1] ?? "";
        index += 1;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      href += char;
    }
  }
  skipSpace();
  const opener = line[index];
  const closer = opener === undefined ? undefined : CLOSERS[opener];
  if (closer !== undefined && index > start) {
    index += 1;
    while (index < line.length && line[index] !== closer) {
      if (line[index] === "\\") index += 1;
      index += 1;
    }
    if (line[index] !== closer) return null;
    index += 1;
    skipSpace();
  }
  return line[index] === ")" ? { href, end: index + 1 } : null;
}
