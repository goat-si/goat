/**
 * GOAT's user guides (docs/user) as agents read them: pages, their sections with the anchors the
 * public site gives them, and a word search over both. Pure functions; UserDocs.ts loads the text.
 */
import GithubSlugger from "github-slugger";

/** Where the public site serves a guide; anchors match its headings (apps/marketing). */
export const USER_GUIDES_BASE_URL = "https://trygoat.ai/docs/user/";

export interface UserGuideSection {
  readonly heading: string;
  readonly depth: 2 | 3;
  readonly anchor: string;
  /** The section's own text, from its heading up to the next heading of any depth. */
  readonly text: string;
}

export interface UserGuidePage {
  readonly page: string;
  readonly title: string;
  readonly url: string;
  readonly markdown: string;
  /** Text before the first section heading, the title line excluded. */
  readonly lead: string;
  readonly sections: ReadonlyArray<UserGuideSection>;
}

/** The heading text a reader sees: inline code, emphasis and links reduced to their words. */
export function headingText(raw: string): string {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*~]/g, "")
    .trim();
}

/** Parses one guide. Lines inside fenced code are never read as headings. */
export function parseUserGuide(page: string, markdown: string): UserGuidePage {
  // The site's anchors: Astro slugs each page's headings with one github-slugger instance.
  const slugger = new GithubSlugger();
  const slug = (heading: string) => slugger.slug(heading);
  let title: string | undefined;
  let fence: string | undefined;
  const lead: Array<string> = [];
  const sections: Array<{ heading: string; depth: 2 | 3; anchor: string; lines: Array<string> }> =
    [];
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker !== undefined)
      fence = fence === undefined ? marker : fence === marker ? undefined : fence;
    const heading =
      fence === undefined && marker === undefined ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    const [, marks, raw] = heading ?? [];
    if (marks !== undefined && raw !== undefined) {
      const depth = marks.length;
      const text = headingText(raw);
      const anchor = slug(text);
      if (depth === 1 && title === undefined) {
        title = text;
        continue;
      }
      if (depth === 2 || depth === 3) {
        sections.push({ heading: text, depth, anchor, lines: [] });
        continue;
      }
    }
    (sections.at(-1)?.lines ?? lead).push(line);
  }
  return {
    page,
    title: title ?? page,
    url: `${USER_GUIDES_BASE_URL}${page}/`,
    markdown,
    lead: lead.join("\n").trim(),
    sections: sections.map(({ lines, ...section }) => ({
      ...section,
      text: lines.join("\n").trim(),
    })),
  };
}

export interface UserGuideMatch {
  readonly page: string;
  readonly title: string;
  /** The matching section's heading, or null for the text before the first section. */
  readonly heading: string | null;
  readonly url: string;
  readonly snippet: string;
  readonly matchedWords: ReadonlyArray<string>;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "do",
  "does",
  "for",
  "how",
  "i",
  "in",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "when",
  "where",
  "why",
  "with",
]);

/** Query words worth matching: lowercase, without punctuation and filler words. */
export function queryWords(query: string): ReadonlyArray<string> {
  const words = query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [];
  return [...new Set(words.filter((word) => !STOP_WORDS.has(word)))];
}

const SNIPPET_LENGTH = 280;

function snippetAround(text: string, words: ReadonlyArray<string>): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const found = words.map((word) => lower.indexOf(word)).filter((index) => index >= 0);
  const start = found.length === 0 ? 0 : Math.max(0, Math.min(...found) - 80);
  const end = start + SNIPPET_LENGTH;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/**
 * Sections holding the query's words, best first. A word in the section's heading counts most, one
 * in the page title next, one only in the body least; shorter sections win ties.
 */
export function searchUserGuides(
  pages: ReadonlyArray<UserGuidePage>,
  query: string,
): { readonly words: ReadonlyArray<string>; readonly matches: ReadonlyArray<UserGuideMatch> } {
  const words = queryWords(query);
  if (words.length === 0) return { words, matches: [] };
  const scored: Array<{ readonly match: UserGuideMatch; readonly score: number }> = [];
  for (const page of pages) {
    const title = page.title.toLowerCase();
    const units = [{ heading: null, anchor: null, text: page.lead }, ...page.sections];
    for (const unit of units) {
      const heading = unit.heading?.toLowerCase() ?? "";
      const body = unit.text.toLowerCase();
      const inHeading = words.filter((word) => heading.includes(word));
      const inTitle = words.filter((word) => title.includes(word));
      const matched = words.filter(
        (word) => inHeading.includes(word) || inTitle.includes(word) || body.includes(word),
      );
      if (matched.length === 0) continue;
      scored.push({
        score:
          matched.length * 60 +
          inHeading.length * 40 +
          inTitle.length * 20 -
          Math.min(9, unit.text.length / 2000),
        match: {
          page: page.page,
          title: page.title,
          heading: unit.heading,
          url: unit.anchor === null ? page.url : `${page.url}#${unit.anchor}`,
          snippet: snippetAround(unit.text === "" ? page.title : unit.text, matched),
          matchedWords: matched,
        },
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return { words, matches: scored.map((entry) => entry.match) };
}
