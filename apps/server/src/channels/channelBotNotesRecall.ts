/**
 * The GOAT Bot notes one message shows: the newest in force, plus older ones that share words
 * with it (BM25 over GOAT memory's search terms). Nothing is indexed; each message reads the file.
 */
import { recallTerms } from "../memory/store/SearchText.ts";
import {
  NOTES_HEADER,
  parseChannelBotNoteLines,
  type ChannelBotNoteLine,
} from "./channelBotNoteLines.ts";

/** The newest notes in force every reader gets, in characters. */
export const NOTES_RECENT_CHARS = 6_000;
/** Older notes that match the message add at most this many characters. */
export const NOTES_MATCHED_CHARS = 3_000;
/** The whole notes section; a file whose notes in force fit goes in whole. */
export const NOTES_SECTION_CHARS = NOTES_RECENT_CHARS + NOTES_MATCHED_CHARS;
/** How much of the end of the notes file is read and searched. */
export const NOTES_SCAN_BYTES = 256 * 1024;

// A long instruction is searched by its start and its end, so the work per message stays bounded.
const QUERY_EDGE_CHARS = 2_000;
const QUERY_HEAD_TERMS = 48;
const QUERY_TAIL_TERMS = 16;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const HANGUL = /[\uAC00-\uD7A3]/u;

export interface ChannelBotNotesSnapshot {
  /** Notes in force every reader gets: the newest ones, or all of them when they fit. */
  readonly standing: string;
  /** Older notes in force that match the query, oldest first; never in `standing`. */
  readonly matched: string;
  /** Every note in force that matches the query, best first, `standing` ones included. */
  readonly ranked: ReadonlyArray<string>;
}

export const EMPTY_NOTES: ChannelBotNotesSnapshot = { standing: "", matched: "", ranked: [] };

/** What the bot reads as its notes: the matched older notes, then the standing ones. */
export const channelBotNotesSection = (notes: ChannelBotNotesSnapshot) =>
  [notes.matched, notes.standing].filter((part) => part !== "").join("\n");

const queryTerms = (query: string) => {
  const head = recallTerms(query.slice(0, QUERY_EDGE_CHARS)).slice(0, QUERY_HEAD_TERMS);
  const tail =
    query.length > QUERY_EDGE_CHARS
      ? recallTerms(query.slice(Math.max(QUERY_EDGE_CHARS, query.length - QUERY_EDGE_CHARS)))
      : [];
  return [...new Set([...head, ...tail.slice(0, QUERY_TAIL_TERMS)])];
};

// Shorter words also match longer ones they start: "deploy" finds "deploys", "보고서" finds "보고서는".
const minPrefix = (term: string) => (HANGUL.test(term) ? 2 : 4);

const firstAtLeast = (sorted: ReadonlyArray<string>, term: string) => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] ?? "") < term) low = middle + 1;
    else high = middle;
  }
  return low;
};

/** BM25 scores of `lines` for `query`; zero where no term matches. */
const scoreLines = (lines: ReadonlyArray<ChannelBotNoteLine>, query: string) => {
  const postings = new Map<string, Array<number>>();
  const lengths = lines.map((line, at) => {
    const terms = recallTerms(line.text);
    for (const term of terms) {
      const list = postings.get(term);
      if (list === undefined) postings.set(term, [at]);
      else list.push(at);
    }
    return terms.length;
  });
  const vocabulary = [...postings.keys()].toSorted();
  const average = lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, lines.length);
  const scores = new Float64Array(lines.length);
  for (const term of queryTerms(query)) {
    const words = new Set<string>();
    if (term.length >= minPrefix(term)) {
      for (let at = firstAtLeast(vocabulary, term); at < vocabulary.length; at++) {
        const word = vocabulary[at] ?? "";
        if (!word.startsWith(term)) break;
        words.add(word);
      }
    } else if (postings.has(term)) words.add(term);
    for (let length = minPrefix(term); length < term.length; length++) {
      if (postings.has(term.slice(0, length))) words.add(term.slice(0, length));
    }
    const frequency = new Map<number, number>();
    for (const word of words) {
      for (const at of postings.get(word) ?? []) frequency.set(at, (frequency.get(at) ?? 0) + 1);
    }
    if (frequency.size === 0) continue;
    const idf = Math.log(1 + (lines.length - frequency.size + 0.5) / (frequency.size + 0.5));
    for (const [at, count] of frequency) {
      const norm = 1 - BM25_B + (BM25_B * (lengths[at] ?? 0)) / Math.max(1, average);
      scores[at] = (scores[at] ?? 0) + (idf * count * (BM25_K1 + 1)) / (count + BM25_K1 * norm);
    }
  }
  return scores;
};

/**
 * The notes for one message from the text of the notes file (or its newest part). Newest wins is
 * judged over all of that text, so a correction hides the note it replaces wherever either sits.
 */
export const selectChannelBotNotes = (text: string, query: string): ChannelBotNotesSnapshot => {
  const normal = text.replaceAll("\r\n", "\n");
  const live = parseChannelBotNoteLines(
    normal.startsWith(NOTES_HEADER) ? normal.slice(NOTES_HEADER.length) : normal,
  ).filter((line) => line.replacedBy === undefined);
  // Lengths as joined: one newline between notes.
  const joined = live.reduce((sum, line, at) => sum + line.raw.length + (at === 0 ? 0 : 1), 0);
  // The newest notes in force, as one unbroken run back from the end.
  let first = live.length;
  let used = 0;
  while (first > 0) {
    const cost = (live[first - 1]?.raw.length ?? 0) + (first === live.length ? 0 : 1);
    if (used + cost > NOTES_RECENT_CHARS) break;
    first--;
    used += cost;
  }
  if (joined <= NOTES_SECTION_CHARS) first = 0;
  const scores = scoreLines(live, query);
  const ranked = live
    .flatMap((line, at) => ((scores[at] ?? 0) > 0 ? [{ line, at, score: scores[at] ?? 0 }] : []))
    .toSorted((left, right) => right.score - left.score || right.at - left.at);
  const matched: Array<{ readonly line: ChannelBotNoteLine; readonly at: number }> = [];
  let room = NOTES_MATCHED_CHARS;
  for (const entry of ranked) {
    if (entry.at >= first || entry.line.raw.length + 1 > room) continue;
    matched.push(entry);
    room -= entry.line.raw.length + 1;
  }
  return {
    standing: live
      .slice(first)
      .map((line) => line.raw)
      .join("\n"),
    matched: matched
      .toSorted((left, right) => left.at - right.at)
      .map((entry) => entry.line.raw)
      .join("\n"),
    ranked: ranked.map((entry) => entry.line.raw),
  };
};
