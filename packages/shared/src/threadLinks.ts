import { GOAT_THREAD_LINK_PROTOCOL, THREAD_LINK_PROTOCOLS } from "@goat/contracts/legacyT3Names";
import { ThreadId, type ScopedThreadRef } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Agents mention another thread in Markdown as `[title](goat-thread://v1/<threadId>)`. The id is
 * the reference and resolves in the environment of the message that holds it. Titles change, so
 * clients show the thread's current title; the label only stands in for a thread they cannot see.
 */
const THREAD_LINK_PROTOCOL = GOAT_THREAD_LINK_PROTOCOL;
const THREAD_LINK_HREF_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
const THREAD_LINK_HREF_PREFIXES = THREAD_LINK_PROTOCOLS.map((protocol) => `${protocol}://v1/`);
const THREAD_HREF = String.raw`(?:${THREAD_LINK_PROTOCOLS.join("|")}):\/\/v1\/`;
// A label stops at any bracket, so a run of unclosed brackets is scanned once, not once per bracket.
const LABEL = String.raw`[^[\]\n]*`;
const LIST_MARKERS = String.raw`(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*`;
const QUOTE_PREFIX = new RegExp(String.raw`^([ \t]*${LIST_MARKERS})(>(?:[ \t]*>)+)`, "gm");
// Move inter-marker spacing before the quote so fence depth matches and offsets stay intact. A label
// may span \r or U+2028, which multiline `^` follows, so labels and output are read from the original.
const threadLinkSource = (markdown: string) =>
  markdown.replace(QUOTE_PREFIX, (_source, indent: string, quote: string) => {
    const markers = quote.replace(/[ \t]/g, "");
    return indent + " ".repeat(quote.length - markers.length) + markers;
  });
// CommonMark fences start on their own line (optional blockquotes, indentation, or list markers)
// and close on a line with at least as many of the same marker; backtick info strings hold no `.
// Quote markers are compared from the first `>`, so lines may indent them differently.
// Space after the markers is matched only after a `>`: two adjacent `[ \t]*` backtrack quadratically.
const AFTER_QUOTE = String.raw`(?:(?<=>)[ \t]*)?`;
const fencedCode = (char: "`" | "~", name: string) => {
  const bq = `${name}Bq`;
  const info = char === "`" ? "[^`\\r\\n]*" : "[^\\r\\n]*";
  const closer = String.raw`[ \t]*\k<${bq}>${AFTER_QUOTE}\k<${name}>${char}*(?!${char})[ \t]*\r?$`;
  return String.raw`^[ \t]*${LIST_MARKERS}(?<${bq}>(?:>(?:[ \t]*>)*)?)(?:(?<=>)[ \t]*${LIST_MARKERS})?(?<${name}>${char}{3,}(?!${char}))${info}(?=\r?$)(?:(?:\r\n?|\n)(?!${closer})[ \t]*\k<${bq}>[^\r\n]*)*(?:(?:\r\n?|\n)${closer})?`;
};
// A code span may wrap lines until its paragraph ends: a blank line, heading, list item, fence, or deeper blockquote.
const SPAN_BREAK_LINE =
  /[ \t>]*(?:\r?$|#{1,6}(?:[ \t]|\r?$)|(?:[-*+]|\d{1,9}[.)])[ \t]|`{3,}[^`\r\n]*\r?$|~{3,})/my;
const LINE_PREFIX = /([ \t]*)(>|(?:[-*+]|\d{1,9}[.)])[ \t]+)?/y;
// Earlier alternatives claim text so later ones cannot match inside it: an escaped character opens
// nothing, code is literal, and a link to anywhere else keeps a thread link in its label or href.
const THREAD_LINK_OUTSIDE_CODE = new RegExp(
  [
    String.raw`\\[!-/:-@[-\`{-~]`,
    fencedCode("`", "bt"),
    fencedCode("~", "tl"),
    String.raw`(?<spanTicks>\`+)`,
    // A labeled link's destination may be angle-bracketed, as CommonMark allows: [label](<href>).
    String.raw`\[${LABEL}\]\((?:<(?<angleHref>${THREAD_HREF}[^\s<>]+)>|(?<href>${THREAD_HREF}[^\s>)]+))\)`,
    String.raw`\[${LABEL}\]\((?:<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\)`,
  ].join("|"),
  "gm",
);

function codeSpanLines(markdown: string) {
  const lines: Array<{ start: number; depth: number }> = [];
  const listIndents: number[] = [];
  let paragraphDepth: number | undefined;
  let start = 0;
  for (const line of markdown.split("\n")) {
    let offset = 0;
    let depth = 0;
    let hasList = false;
    let listOffset = 0;
    while (offset < line.length) {
      LINE_PREFIX.lastIndex = offset;
      const prefix = LINE_PREFIX.exec(line);
      if (prefix === null) break;
      const indent = (prefix[1] ?? "").replace(/\t/g, "    ").length;
      if (
        listOffset === 0 &&
        paragraphDepth === undefined &&
        indent < (listIndents[depth] ?? 0) &&
        line.trim()
      ) {
        listIndents.length = depth;
      }
      const containerIndent = listIndents[depth] ?? 0;
      const continuedIndent = indent >= containerIndent ? containerIndent : 0;
      if (prefix[2] === undefined || indent - continuedIndent > 3) break;
      offset = LINE_PREFIX.lastIndex;
      if (prefix[2] === ">") {
        depth++;
        listOffset = 0;
        if (line[offset] === " " || line[offset] === "\t") offset++;
      } else {
        listOffset += indent + prefix[2].replace(/\t/g, "    ").length;
        listIndents[depth] = listOffset;
        hasList = true;
      }
    }
    const content = line.slice(offset);
    const endsParagraph =
      /^(?:[ \t\r]*$|[ \t]*#{1,6}(?:[ \t]|$)|[ \t]*`{3,}[^`]*$|[ \t]*~{3,})/.test(content);
    const effectiveDepth = endsParagraph || hasList ? depth : Math.max(depth, paragraphDepth ?? 0);
    lines.push({ start, depth: effectiveDepth });
    paragraphDepth = endsParagraph ? undefined : effectiveDepth;
    start += line.length + 1;
  }
  return lines;
}

function findCodeSpanEnd(
  markdown: string,
  openIndex: number,
  tickCount: number,
  lines: ReturnType<typeof codeSpanLines>,
  lineIndex: number,
): number {
  const openDepth = lines[lineIndex]?.depth ?? 0;
  for (let i = openIndex + tickCount; i < markdown.length; i++) {
    if (markdown[i] === "`") {
      let runEnd = i + 1;
      while (markdown[runEnd] === "`") runEnd++;
      if (runEnd - i === tickCount) return runEnd;
      i = runEnd - 1;
    } else if (markdown[i] === "\n") {
      lineIndex++;
      SPAN_BREAK_LINE.lastIndex = i + 1;
      if (SPAN_BREAK_LINE.test(markdown) || (lines[lineIndex]?.depth ?? 0) > openDepth) return -1;
    }
  }
  return -1;
}

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** The id as written. Thread ids can hold percent escapes of their own, so it is not decoded. */
export function parseThreadLinkHref(href: string): ThreadId | null {
  const prefix = THREAD_LINK_HREF_PREFIXES.find((prefix) => href.startsWith(prefix));
  if (prefix === undefined) return null;
  return Option.getOrNull(decodeThreadId(href.slice(prefix.length)));
}

export function percentDecodedThreadLinkId(threadId: ThreadId): ThreadId | null {
  try {
    const decoded = decodeURIComponent(threadId);
    return decoded === threadId ? null : Option.getOrNull(decodeThreadId(decoded));
  } catch {
    return null;
  }
}

export function resolveThreadLinkRef(
  source: ScopedThreadRef,
  refs: ReadonlyArray<ScopedThreadRef>,
): ScopedThreadRef | null {
  const decodedId = percentDecodedThreadLinkId(source.threadId);
  const ids = decodedId === null ? [source.threadId] : [source.threadId, decodedId];
  for (const threadId of ids) {
    const local = refs.find(
      (ref) => ref.environmentId === source.environmentId && ref.threadId === threadId,
    );
    if (local) return local;
  }
  for (const threadId of ids) {
    let match: ScopedThreadRef | null = null;
    for (const ref of refs) {
      if (ref.threadId !== threadId) continue;
      if (match !== null) return null;
      match = ref;
    }
    if (match !== null) return match;
  }
  return null;
}

/** `href` replaces the `goat-thread://` reference for readers that cannot open it. */
export function formatThreadLink(
  threadId: string,
  label: string,
  href = `${THREAD_LINK_HREF_PREFIX}${threadId}`,
): string {
  const cleaned = label
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const destination = /[()]/.test(href) ? `<${href}>` : href;
  return `[${cleaned || threadId}](${destination})`;
}

export function hasThreadLinks(markdown: string): boolean {
  return THREAD_LINK_HREF_PREFIXES.some(
    (prefix) => markdown.includes(`](${prefix}`) || markdown.includes(`](<${prefix}`),
  );
}

// Each unheld link of a message asks for its ids on every render. Keys are whole message texts,
// and every streamed chunk is a new one, so the cache is bounded by the characters it holds.
const THREAD_LINK_IDS_CACHE_CHARACTERS = 200_000;
const threadLinkIdsCache = new Map<string, ReadonlyArray<ThreadId>>();
let threadLinkIdsCachedCharacters = 0;
// A text over the bound gets one slot of its own, so the latest long message is scanned once.
let latestLongThreadLinkText: { readonly markdown: string; readonly ids: ReadonlyArray<ThreadId> } =
  {
    markdown: "",
    ids: [],
  };

export function threadLinkIdsCacheCharacters(): number {
  return threadLinkIdsCachedCharacters;
}

/** Every thread a message links, as written and percent-decoded, once each, outside code. */
export function threadLinkIds(markdown: string): ReadonlyArray<ThreadId> {
  if (!hasThreadLinks(markdown)) return [];
  const cached = threadLinkIdsCache.get(markdown);
  if (cached !== undefined) return cached;
  if (latestLongThreadLinkText.markdown === markdown) return latestLongThreadLinkText.ids;
  const ids = scanThreadLinkIds(markdown);
  if (markdown.length > THREAD_LINK_IDS_CACHE_CHARACTERS) {
    latestLongThreadLinkText = { markdown, ids };
    return ids;
  }
  for (const oldest of threadLinkIdsCache.keys()) {
    if (threadLinkIdsCachedCharacters + markdown.length <= THREAD_LINK_IDS_CACHE_CHARACTERS) break;
    threadLinkIdsCache.delete(oldest);
    threadLinkIdsCachedCharacters -= oldest.length;
  }
  threadLinkIdsCache.set(markdown, ids);
  threadLinkIdsCachedCharacters += markdown.length;
  return ids;
}

function* threadLinkMatches(markdown: string) {
  const pattern = new RegExp(THREAD_LINK_OUTSIDE_CODE);
  const source = threadLinkSource(markdown);

  let lines: ReturnType<typeof codeSpanLines> | undefined;
  let lineIndex = 0;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const spanTicks = match.groups?.spanTicks;
    if (spanTicks !== undefined) {
      lines ??= codeSpanLines(markdown);
      while (
        lineIndex + 1 < lines.length &&
        (lines[lineIndex + 1]?.start ?? Infinity) <= match.index
      )
        lineIndex++;
      const spanEnd = findCodeSpanEnd(markdown, match.index, spanTicks.length, lines, lineIndex);
      if (spanEnd !== -1) pattern.lastIndex = spanEnd;
      continue;
    }
    if (match.groups?.angleHref !== undefined || match.groups?.href !== undefined) yield match;
  }
}

function scanThreadLinkIds(markdown: string): ReadonlyArray<ThreadId> {
  const ids = new Set<ThreadId>();
  for (const match of threadLinkMatches(markdown)) {
    const href = match.groups?.angleHref ?? match.groups?.href;
    const written = href === undefined ? null : parseThreadLinkHref(href);
    if (written === null) continue;
    ids.add(written);
    const decoded = percentDecodedThreadLinkId(written);
    if (decoded !== null) ids.add(decoded);
  }
  return [...ids];
}

export function relabelThreadLinks(
  markdown: string,
  title: (threadId: ThreadId) => string | undefined,
): string {
  if (!hasThreadLinks(markdown)) return markdown;
  let result = "";
  let cursor = 0;
  for (const match of threadLinkMatches(markdown)) {
    const href = match.groups?.angleHref ?? match.groups?.href;
    const written = href === undefined ? null : parseThreadLinkHref(href);
    if (written === null) continue;
    const decoded = percentDecodedThreadLinkId(written);
    const threadId =
      title(written) === undefined && decoded !== null && title(decoded) !== undefined
        ? decoded
        : written;
    const label = title(threadId)?.trim();
    if (!label) continue;
    result += markdown.slice(cursor, match.index) + formatThreadLink(threadId, label);

    cursor = match.index + match[0].length;
  }
  return cursor === 0 ? markdown : result + markdown.slice(cursor);
}
