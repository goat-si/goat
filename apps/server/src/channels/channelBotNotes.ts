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

/** The newest part of the notes reception reads, in characters. */
const NOTES_READ_CHARS = 6_000;
const NOTE_MAX_CHARS = 500;
const SKILLS_LIMIT = 20;
const SKILL_SUMMARY_CHARS = 200;

const NOTES_HEADER =
  "# GOAT Bot notes\n\nStanding notes people asked GOAT Bot to keep, newest last. Edit or delete lines freely.\n\n";

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

/** The newest notes, or an empty string when there are none or they cannot be read. */
export const readChannelBotNotes = (fs: FileSystem.FileSystem, files: ChannelBotFiles) =>
  Effect.gen(function* () {
    const text = yield* fs.readFileString(files.notes);
    const body = text.startsWith(NOTES_HEADER) ? text.slice(NOTES_HEADER.length) : text;
    return body.length <= NOTES_READ_CHARS ? body.trim() : body.slice(-NOTES_READ_CHARS).trim();
  }).pipe(Effect.orElseSucceed(() => ""));

/**
 * Appends one note as a single dated line, naming the channel input that asked for it. A note
 * for an input already named in the file is not added again, so a repeated pass is harmless.
 */
export const appendChannelBotNote = (
  fs: FileSystem.FileSystem,
  files: ChannelBotFiles,
  note: string,
  date: string,
  sourceInputId: string,
) =>
  Effect.gen(function* () {
    const line = note.replace(/\s+/gu, " ").trim().slice(0, NOTE_MAX_CHARS);
    if (line === "") return;
    const source = " (asked in " + sourceInputId.replace(/\s+/gu, "") + ")";
    yield* fs.makeDirectory(files.dir, { recursive: true });
    const exists = yield* fs.exists(files.notes);
    if (exists && (yield* fs.readFileString(files.notes)).includes(source)) return;
    yield* fs.writeFileString(
      files.notes,
      (exists ? "" : NOTES_HEADER) + "- " + date.slice(0, 10) + ": " + line + source + "\n",
      { flag: "a" },
    );
  });

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
