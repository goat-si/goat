import type { AgentSurfaceEntry } from "@goat/contracts/agentSurface";
import { resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";

type Searchable = AgentSurfaceEntry & {
  readonly path: string;
  readonly legacyNames: ReadonlyArray<string>;
};

/** How an entry matched: by one of its names, by every word, or by some of them. */
export type MatchKind = "exact" | "all" | "partial";

export interface Match<Entry> {
  readonly entry: Entry;
  readonly match: MatchKind;
  readonly matchedWords: ReadonlyArray<string>;
  readonly unmatchedWords: ReadonlyArray<string>;
}

export interface SearchOutcome<Entry> {
  /** The words matched against entries, after dropping words such as "the" and "which". */
  readonly words: ReadonlyArray<string>;
  readonly ignoredWords: ReadonlyArray<string>;
  /** The best match: the query named an entry, some entry has every word, or only some. */
  readonly mode: "exact" | "all" | "partial" | "none";
  /** Exact first, then every-word matches, then partial ones by how many words they share. */
  readonly matches: ReadonlyArray<Match<Entry>>;
}

// Words that say how a question is phrased, not what it is about. Dropped only when the query
// has other words, so a search for "which" still runs.
const STOP_WORDS: ReadonlySet<string> = new Set(
  "a an and any are as at be by can do does for from has have how i in into is it its me my of on or should that the this to what when where which who why will with".split(
    " ",
  ),
);

const tokens = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token !== "");

/** "queries" reads as "query", so a -y word and its -ies plural share a stem. */
const unY = (word: string) =>
  word.length > 4 && word.endsWith("ies") ? word.slice(0, -3) + "y" : word;

/** Equal, or one extends the other by a short ending ("status" and "statuses"). */
const extendsWord = (a: string, b: string) => {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.length - short.length <= 3 && long.startsWith(short);
};

/**
 * Two forms of one word, compared as spelled ("cookie" and "cookies") and with -ies read as -y
 * ("policy" and "policies"). Symmetric, so plural and singular find each other.
 */
const sameWord = (left: string, right: string) =>
  extendsWord(left, right) || extendsWord(unY(left), unY(right));

/**
 * The words an entry is named by: its resource, verb and tool names, plus the initials of a
 * resource of several words, so "pr" finds pull_request without a synonym list.
 */
const nameTokens = (entry: Searchable) => {
  const parts = entry.resource.split("_");
  return new Set([
    ...tokens(`${entry.path} ${entry.name} ${entry.legacyNames.join(" ")}`),
    ...(parts.length > 1 ? [parts.map((part) => part[0]).join("")] : []),
  ]);
};

interface Fields {
  readonly resource: string;
  readonly names: ReadonlySet<string>;
  readonly summary: ReadonlySet<string>;
  readonly text: ReadonlySet<string>;
}

const fieldsOf = (entry: Searchable): Fields => ({
  resource: entry.resource,
  names: nameTokens(entry),
  summary: new Set(tokens(entry.summary)),
  // Text moved from a description into its guide must stay findable.
  text: new Set(tokens(`${entry.description} ${entry.guide ?? ""}`)),
});

const hasWord = (field: ReadonlySet<string>, word: string) => {
  for (const token of field) if (sameWord(token, word)) return true;
  return false;
};

const startsAName = (field: ReadonlySet<string>, word: string) => {
  if (word.length < 3) return false;
  for (const token of field) if (token.startsWith(word)) return true;
  return false;
};

/**
 * 5 when the word is the whole resource ("host" for host.status, not host_link.list), 4 when it
 * is a word of a name or a resource's initials, 3 when it starts one, 2 for the summary, 1 for
 * the description or guide.
 */
const tier = (fields: Fields, word: string) =>
  fields.resource === word
    ? 5
    : hasWord(fields.names, word)
      ? 4
      : startsAName(fields.names, word)
        ? 3
        : hasWord(fields.summary, word)
          ? 2
          : hasWord(fields.text, word)
            ? 1
            : 0;

/**
 * Exact names resolve first, so a tool named outright is never lost behind text matches. Then
 * entries with every word, then entries sharing only some, by how many words, by a score that
 * weighs rare words and name matches most, and by path, so a query always answers the same way.
 */
export const searchEntries = <Entry extends Searchable>(
  candidates: ReadonlyArray<Entry>,
  query: string,
): SearchOutcome<Entry> => {
  const all = [...new Set(tokens(query))];
  const meaningful = all.filter((word) => !STOP_WORDS.has(word));
  const words = meaningful.length > 0 ? meaningful : all;
  const ignoredWords = all.filter((word) => !words.includes(word));
  const exact = resolveAgentSurfaceEntry(query.trim());
  const exactEntry = candidates.find((entry) => entry.path === exact?.path);

  const rows = candidates.map((entry) => {
    const fields = fieldsOf(entry);
    return { entry, tiers: words.map((word) => tier(fields, word)) };
  });
  // Rare words tell entries apart; one that every entry has decides little.
  const weight = words.map((_, index) => {
    const holders = rows.filter(({ tiers }) => (tiers[index] ?? 0) > 0).length;
    return holders === 0 ? 0 : Math.log(1 + candidates.length / holders);
  });
  const scored = rows.flatMap(({ entry, tiers }) => {
    if (entry === exactEntry) return [];
    const matchedWords = words.filter((_, index) => (tiers[index] ?? 0) > 0);
    if (matchedWords.length === 0) return [];
    const score = tiers.reduce<number>(
      (total, points, index) => total + points * (weight[index] ?? 0),
      0,
    );
    return [{ entry, matchedWords, score }];
  });
  const ranked = scored.toSorted(
    (a, b) =>
      b.matchedWords.length - a.matchedWords.length ||
      b.score - a.score ||
      a.entry.path.localeCompare(b.entry.path),
  );
  const matches: Array<Match<Entry>> = ranked.map(({ entry, matchedWords }) => ({
    entry,
    match: matchedWords.length === words.length ? "all" : "partial",
    matchedWords,
    unmatchedWords: words.filter((word) => !matchedWords.includes(word)),
  }));
  return {
    words,
    ignoredWords,
    mode:
      exactEntry !== undefined
        ? "exact"
        : matches.some((match) => match.match === "all")
          ? "all"
          : matches.length > 0
            ? "partial"
            : "none",
    matches: [
      ...(exactEntry === undefined
        ? []
        : [{ entry: exactEntry, match: "exact" as const, matchedWords: [], unmatchedWords: [] }]),
      ...matches,
    ],
  };
};

/** Levenshtein distance, row by row. */
const distance = (a: string, b: string) => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (const [i, left] of [...a].entries()) {
    const current = [i + 1];
    for (const [j, right] of [...b].entries())
      current.push(
        Math.min(
          (previous[j + 1] ?? 0) + 1,
          (current[j] ?? 0) + 1,
          (previous[j] ?? 0) + (left === right ? 0 : 1),
        ),
      );
    previous = current;
  }
  return previous[b.length] ?? 0;
};

const NEAREST_QUERY_CHARS = 64;

/** Paths spelled closest to the query, for a search nothing matched. */
export const nearestPaths = (
  candidates: ReadonlyArray<Searchable>,
  query: string,
  count = 3,
): ReadonlyArray<string> => {
  // Paths are short; a longer query only costs time to compare.
  const target = query.trim().toLowerCase().replaceAll(/\s+/gu, "_").slice(0, NEAREST_QUERY_CHARS);
  return candidates
    .map((entry) => ({
      path: entry.path,
      distance: Math.min(
        distance(target, entry.path),
        distance(target, entry.name),
        distance(target, `${entry.resource}_${entry.verb}`),
      ),
    }))
    .toSorted((a, b) => a.distance - b.distance || a.path.localeCompare(b.path))
    .slice(0, count)
    .map(({ path }) => path);
};
