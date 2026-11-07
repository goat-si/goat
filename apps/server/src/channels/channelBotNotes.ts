/**
 * GOAT Bot's notes and skills: plain files on the bot's home machine that every reception pass
 * reads and every worker can open.
 *
 * `memory.md` holds standing notes the people using the bot asked it to keep, one line each,
 * newest last. Reception appends to it; editing or deleting a note is ordinary file work for a
 * worker. `skills/*.md` holds written procedures; reception sees each by name and first line,
 * and workers read the file itself. Slack and the GOAT bot share one reception, so they share
 * these files too.
 *
 * @module channelBotNotes
 */
import type { ChannelReceptionSkill } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  collapseNoteText,
  NOTES_HEADER,
  notesTail,
  noteNamedBy,
  parseChannelBotNoteLines,
  replacesMarker,
} from "./channelBotNoteLines.ts";
import {
  channelBotNotesSection,
  EMPTY_NOTES,
  NOTES_SCAN_BYTES,
  selectChannelBotNotes,
  type ChannelBotNotesSnapshot,
} from "./channelBotNotesRecall.ts";
import { readChannelBotNotesTail } from "./channelBotNotesTail.ts";

/** How far back a correction looks for the note it replaces, in characters. */
const CORRECTION_READ_CHARS = 64 * 1024;
const NOTE_MAX_CHARS = 500;
const SKILLS_LIMIT = 20;
const SKILL_SUMMARY_CHARS = 200;

/** Told to every agent that reads the notes file itself. */
export const NOTES_REPLACED_RULE =
  'A note line ending in (replaces: "<old text>") replaces the earlier note with that text; follow the newer note.';

export interface ChannelBotFiles {
  readonly dir: string;
  readonly notes: string;
  readonly skills: string;
  readonly scratch: string;
  readonly artifacts: string;
}

export const channelBotFilesFor = (path: Path.Path, stateDir: string): ChannelBotFiles => {
  const dir = path.join(stateDir, "goat-bot");
  return {
    dir,
    notes: path.join(dir, "memory.md"),
    skills: path.join(dir, "skills"),
    scratch: path.join(dir, "scratch"),
    artifacts: path.join(dir, "artifacts"),
  };
};

/**
 * The notes to show the bot for `query` (the message, request or instruction at hand), read from
 * the newest part of the file; undefined when the file cannot be read, so a caller can tell a
 * failed read from a file with no notes.
 */
export const readChannelBotNotesSnapshot = Effect.fn("channelBotNotes.readSnapshot")(
  function* (files: ChannelBotFiles, query: string) {
    const tail = yield* readChannelBotNotesTail(files.notes, NOTES_SCAN_BYTES);
    if (tail === null) return EMPTY_NOTES;
    return selectChannelBotNotes(new TextDecoder().decode(tail.bytes), query);
  },
  (effect) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("GOAT Bot notes could not be read", { cause }).pipe(
          Effect.as<ChannelBotNotesSnapshot | undefined>(undefined),
        ),
      ),
    ),
);

/** The notes section for `query`, or an empty string when there are none or they cannot be read. */
export const readChannelBotNotes = (files: ChannelBotFiles, query: string) =>
  Effect.map(readChannelBotNotesSnapshot(files, query), (notes) =>
    notes === undefined ? "" : channelBotNotesSection(notes),
  );

export interface ChannelBotNoteSaved {
  /** Set when the note was a correction: whether it replaced the note it named. */
  readonly correction?: "replaced" | "unmatched";
}

/** How a note line names the input that asked for it; ids keep no whitespace, so the name ends at ")". */
export const noteSource = (sourceInputId: string) =>
  " (asked in " + sourceInputId.replace(/\s+/gu, "") + ")";

/**
 * The calendar day of `at` where GOAT runs: the current time zone when one is set, else this
 * machine's. People and models read the day in the notes file, so UTC would be a day off.
 */
export const noteDay = (at: string) =>
  Effect.map(Effect.serviceOption(DateTime.CurrentTimeZone), (zone) =>
    DateTime.formatIsoDate(
      DateTime.setZone(DateTime.makeUnsafe(at), Option.getOrElse(zone, DateTime.zoneMakeLocal)),
    ),
  );

/** One dated note line as reception writes it, or undefined for an empty note. `day` is YYYY-MM-DD. */
export const channelBotNoteLine = (
  note: string,
  day: string,
  sourceInputId: string,
  replaces?: string,
) => {
  const text = collapseNoteText(note).slice(0, NOTE_MAX_CHARS);
  if (text === "") return undefined;
  return (
    "- " +
    day.slice(0, 10) +
    ": " +
    text +
    noteSource(sourceInputId) +
    (replaces === undefined ? "" : replacesMarker(replaces))
  );
};

/** What appending to `text` must start with, so a hand edit without a final newline keeps its line. */
export const appendPrefix = (exists: boolean, text: string) =>
  !exists ? NOTES_HEADER : text === "" || text.endsWith("\n") ? "" : "\n";

/**
 * Appends one note as a single dated line, naming the channel input that asked for it. A note
 * for an input already named in the file is not added again, so a repeated pass is harmless and
 * reports what the first pass saved. A correction names the note it replaces; the line records
 * that only when the note is found, otherwise the note is kept plainly and reported unmatched.
 */
export const appendChannelBotNote = (
  fs: FileSystem.FileSystem,
  files: ChannelBotFiles,
  note: string,
  date: string,
  sourceInputId: string,
  replaces?: string,
) =>
  Effect.gen(function* () {
    const nothing: ChannelBotNoteSaved = {};
    const day = yield* noteDay(date);
    if (channelBotNoteLine(note, day, sourceInputId) === undefined) return nothing;
    const source = noteSource(sourceInputId);
    const saved = (replaced: boolean): ChannelBotNoteSaved =>
      replaces === undefined ? {} : { correction: replaced ? "replaced" : "unmatched" };
    yield* fs.makeDirectory(files.dir, { recursive: true });
    const exists = yield* fs.exists(files.notes);
    const text = exists ? yield* fs.readFileString(files.notes) : "";
    if (text.includes(source)) {
      const first = parseChannelBotNoteLines(text).find((earlier) => earlier.raw.includes(source));
      return saved(first?.replaces !== undefined);
    }
    const target =
      replaces === undefined
        ? undefined
        : noteNamedBy(parseChannelBotNoteLines(notesTail(text, CORRECTION_READ_CHARS)), replaces);
    yield* fs.writeFileString(
      files.notes,
      appendPrefix(exists, text) +
        channelBotNoteLine(note, day, sourceInputId, target?.text) +
        "\n",
      { flag: "a" },
    );
    return saved(target !== undefined);
  });

// Typography a model may change when it copies words: case, curly quotes, dashes, spacing.
const comparable = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/gu, '"')
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
const TRAILING_PUNCTUATION = /[\s.!?\u2026"')\]]+$/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;
// Scripts that separate words with spaces; Korean and Japanese attach particles and endings, so a
// quote there may stop inside a written word.
const SPACED_WORD_CHAR = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}]/u;

/** The code point that ends just before `at`, reading a surrogate pair whole. */
const codePointBefore = (text: string, at: number) => {
  if (at <= 0) return undefined;
  const low = text.charCodeAt(at - 1);
  const high = at >= 2 ? text.charCodeAt(at - 2) : 0;
  const pair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  return text.slice(pair ? at - 2 : at - 1, at);
};

const codePointFrom = (text: string, at: number) => {
  const point = text.codePointAt(at);
  return point === undefined ? undefined : String.fromCodePoint(point);
};

const atWordBoundaries = (haystack: string, needle: string) => {
  const first = codePointFrom(needle, 0) ?? "";
  const last = codePointBefore(needle, needle.length) ?? "";
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = codePointBefore(haystack, at);
    const after = codePointFrom(haystack, at + needle.length);
    const cutsBefore =
      SPACED_WORD_CHAR.test(first) && before !== undefined && SPACED_WORD_CHAR.test(before);
    const cutsAfter =
      SPACED_WORD_CHAR.test(last) && after !== undefined && SPACED_WORD_CHAR.test(after);
    if (!cutsBefore && !cutsAfter) return true;
  }
  return false;
};

/**
 * Whether `quote` occurs in the person's message as whole words, ignoring case, curly quotes,
 * dashes, spacing and sentence punctuation the quote adds at its end. Used to check that a note
 * request the model reports came from the current input; every other character must match.
 */
export const quotedFromInput = (quote: string, input: string): boolean => {
  const haystack = comparable(input);
  const whole = comparable(quote);
  return [whole, whole.replace(TRAILING_PUNCTUATION, "")].some(
    (needle) => WORD_CHAR.test(needle) && atWordBoundaries(haystack, needle),
  );
};

/** Skills by file name and first line, alphabetically. A missing folder means none. */
export const listChannelBotSkills = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  files: ChannelBotFiles,
) =>
  Effect.gen(function* () {
    const names = (yield* fs.readDirectory(files.skills))
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .toSorted()
      .slice(0, SKILLS_LIMIT);
    return yield* Effect.forEach(names, (name) =>
      fs.readFileString(path.join(files.skills, name)).pipe(
        Effect.map((text): ChannelReceptionSkill => {
          const first =
            text
              .split("\n")
              .map((line) => line.replace(/^#+\s*/u, "").trim())
              .find((line) => line !== "") ?? "";
          return { name: name.slice(0, -3), summary: first.slice(0, SKILL_SUMMARY_CHARS) };
        }),
        Effect.orElseSucceed((): ChannelReceptionSkill => ({
          name: name.slice(0, -3),
          summary: "",
        })),
      ),
    );
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<ChannelReceptionSkill> => []));
