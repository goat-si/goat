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
// Earlier alternatives claim text so later ones cannot match inside it: an escaped character opens
// nothing, code is literal, and a link to anywhere else keeps a thread link in its label or href.
const THREAD_LINK_OUTSIDE_CODE = new RegExp(
  [
    String.raw`\\[!-/:-@[-\`{-~]`,
    String.raw`(?<fence>(\`{3,}|~{3,})[\s\S]*?(?:\2|$))`,
    String.raw`(?<span>(\`+)[^\n]*?\4)`,
    // A labeled link's destination may be angle-bracketed, as CommonMark allows: [label](<href>).
    String.raw`\[${LABEL}\]\((?:<(?<angleHref>${THREAD_HREF}[^\s<>]+)>|(?<href>${THREAD_HREF}[^\s>)]+))\)`,
    String.raw`\[${LABEL}\]\((?:<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\)`,
  ].join("|"),
  "g",
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
