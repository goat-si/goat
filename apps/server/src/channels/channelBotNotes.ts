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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { CHANNEL_COPY } from "./channelCopy.ts";
import {
  collapseNoteText,
  NOTES_HEADER,
  notesTail,
  noteNamedBy,
  parseChannelBotNoteLines,
  replacesMarker,
} from "./channelBotNoteLines.ts";

/** The newest part of the notes reception reads, in characters. */
const NOTES_READ_CHARS = 6_000;
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
 * The newest notes still in force, one line each, or an empty string when there are none or they
 * cannot be read. A replaced note is left out; its replacement is always later, so the newest part
 * of the file decides that alone.
 */
export const readChannelBotNotes = (fs: FileSystem.FileSystem, files: ChannelBotFiles) =>
  Effect.gen(function* () {
    const text = yield* fs.readFileString(files.notes);
    const body = text.startsWith(NOTES_HEADER) ? text.slice(NOTES_HEADER.length) : text;
    return parseChannelBotNoteLines(notesTail(body, NOTES_READ_CHARS))
      .filter((line) => line.replacedBy === undefined)
      .map((line) => line.raw)
      .join("\n");
  }).pipe(Effect.orElseSucceed(() => ""));

export interface ChannelBotNoteSaved {
  /** Set when the note was a correction: whether it replaced the note it named. */
  readonly correction?: "replaced" | "unmatched";
}

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
    const line = collapseNoteText(note).slice(0, NOTE_MAX_CHARS);
    if (line === "") return nothing;
    const source = " (asked in " + sourceInputId.replace(/\s+/gu, "") + ")";
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
      (exists ? "" : NOTES_HEADER) +
        "- " +
        date.slice(0, 10) +
        ": " +
        line +
        source +
        (target === undefined ? "" : replacesMarker(target.text)) +
        "\n",
      { flag: "a" },
    );
    return saved(target !== undefined);
  });

/**
 * Saves notes one at a time, so a correction sees the note the one before it saved. Each save
 * answers what the reply must add: a correction that matched nothing, or a failed save.
 */
export const makeChannelBotNoteSaver = (fs: FileSystem.FileSystem, files: ChannelBotFiles) =>
  Effect.map(
    Semaphore.make(1),
    (gate) => (note: string, readAt: string, inputId: string, replaces?: string) =>
      gate
        .withPermits(1)(appendChannelBotNote(fs, files, note, readAt, inputId, replaces))
        .pipe(
          Effect.map(({ correction }) =>
            correction === "unmatched" ? CHANNEL_COPY.noteCorrectionUnmatched : undefined,
          ),
          Effect.catch((cause) =>
            Effect.logWarning("GOAT Bot note was not saved", { cause }).pipe(
              Effect.as(CHANNEL_COPY.noteNotSaved),
            ),
          ),
        ),
  );

/**
 * Whether `quote` occurs in the person's message, ignoring differences in whitespace. Used to
 * check that a note request the model reports came from the current input.
 */
export const quotedFromInput = (quote: string, input: string): boolean => {
  const collapse = (text: string) => text.replace(/\s+/gu, " ").trim();
  const needle = collapse(quote);
  return needle !== "" && collapse(input).includes(needle);
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
