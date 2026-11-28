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
// CommonMark fences start on their own line (optional blockquotes, indentation, or list markers)
// and close on a line with at least as many of the same marker; backtick info strings hold no `.
// Quote markers are compared from the first `>`, so lines may indent them differently.
// Space after the markers is matched only after a `>`: two adjacent `[ \t]*` backtrack quadratically.
const AFTER_QUOTE = String.raw`(?:(?<=>)[ \t]*)?`;
const fencedCode = (char: "`" | "~", name: string) => {
  const bq = `${name}Bq`;
  const info = char === "`" ? "[^`\\r\\n]*" : "[^\\r\\n]*";
  const closer = String.raw`[ \t]*\k<${bq}>${AFTER_QUOTE}\k<${name}>${char}*(?!${char})[ \t]*\r?$`;
  return String.raw`^[ \t]*${LIST_MARKERS}(?<${bq}>(?:>(?:[ \t]*>)*)?)(?:(?<=>)[ \t]*${LIST_MARKERS})?(?<${name}>${char}{3,}(?!${char}))${info}(?=\r?$)(?:\r?\n(?!${closer})[ \t]*\k<${bq}>[^\r\n]*)*(?:\r?\n${closer})?`;
};
// A code span may wrap lines but ends where its paragraph does: a blank line, heading, list item, or fence.
const SPAN_LINE_BREAK = String.raw`\n(?![ \t>]*(?:\r?$|#{1,6}(?:[ \t]|\r?$)|(?:[-*+]|\d{1,9}[.)])[ \t]|\`{3,}[^\`\r\n]*\r?$|~{3,}))`;
// Earlier alternatives claim text so later ones cannot match inside it: an escaped character opens
// nothing, code is literal, and a link to anywhere else keeps a thread link in its label or href.
const THREAD_LINK_OUTSIDE_CODE = new RegExp(
  [
    String.raw`\\[!-/:-@[-\`{-~]`,
    fencedCode("`", "bt"),
    fencedCode("~", "tl"),
    String.raw`(?<span>(?<!\`)(?<spanTicks>\`+)(?!\`)(?:[^\n]|${SPAN_LINE_BREAK})*?(?<!\`)\k<spanTicks>(?!\`))`,
    // A labeled link's destination may be angle-bracketed, as CommonMark allows: [label](<href>).
    String.raw`\[${LABEL}\]\((?:<(?<angleHref>${THREAD_HREF}[^\s<>]+)>|(?<href>${THREAD_HREF}[^\s>)]+))\)`,
    String.raw`\[${LABEL}\]\((?:<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\)`,
  ].join("|"),
  "gm",
);

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

function scanThreadLinkIds(markdown: string): ReadonlyArray<ThreadId> {
  const ids = new Set<ThreadId>();
  for (const match of markdown.matchAll(THREAD_LINK_OUTSIDE_CODE)) {
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
  return markdown.replace(THREAD_LINK_OUTSIDE_CODE, (source, ...args) => {
    const href =
      (args.at(-1) as { angleHref?: string; href?: string }).angleHref ??
      (args.at(-1) as { href?: string }).href;
    if (href === undefined) return source;
    const written = parseThreadLinkHref(href);
    if (written === null) return source;
    const decoded = percentDecodedThreadLinkId(written);
    const threadId =
      title(written) === undefined && decoded !== null && title(decoded) !== undefined
        ? decoded
        : written;
    const label = title(threadId)?.trim();
    return label ? formatThreadLink(threadId, label) : source;
  });
}
