import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";
import { BotId } from "./botProfile.ts";
import { ChannelKind } from "./channelCommon.ts";

/**
 * Where a note was asked for. Details only for the person who asked or a caller who may read every
 * GOAT Bot conversation; otherwise "elsewhere", which also covers a source GOAT no longer has.
 */
export const ChannelBotNoteSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("shown"),
    inputId: Schema.String,
    channel: ChannelKind,
    botId: BotId,
    from: Schema.String,
    at: IsoDateTime,
  }),
  Schema.Struct({ kind: Schema.Literal("elsewhere") }),
]);
export type ChannelBotNoteSource = typeof ChannelBotNoteSource.Type;

/** One line of GOAT Bot's notes file. `date` is null for a line a person or worker wrote by hand. */
export const ChannelBotNote = Schema.Struct({
  /** Position among the lines read, oldest first, so a client can key rows. */
  index: NonNegativeInt,
  /**
   * Names this line in a change or forget request, so one of several notes with the same words
   * can be picked. Stays while the line is unchanged. Absent from servers that take requests
   * naming a note by its words only.
   */
  id: Schema.optionalKey(Schema.String),
  /** `YYYY-MM-DD`. */
  date: Schema.NullOr(Schema.String),
  text: Schema.String,
  /** The text of the earlier note this line replaced. */
  replaces: Schema.optionalKey(Schema.String),
  /** `index` of the later line that replaced this note; such a note no longer applies. */
  replacedBy: Schema.optionalKey(NonNegativeInt),
  /** Absent for a line written by hand. */
  source: Schema.optionalKey(ChannelBotNoteSource),
});
export type ChannelBotNote = typeof ChannelBotNote.Type;

export const ChannelListBotNotesInput = Schema.Struct({});
export type ChannelListBotNotesInput = typeof ChannelListBotNotesInput.Type;

export const ChannelListBotNotesResult = Schema.Struct({
  /** sha-256 of the bytes read; null when there is no notes file. */
  revision: Schema.NullOr(Schema.String),
  /** Newest first. */
  notes: Schema.Array(ChannelBotNote),
  /** Only the newest part of a large file was read. */
  truncated: Schema.Boolean,
});
export type ChannelListBotNotesResult = typeof ChannelListBotNotesResult.Type;

// Reception answers these sentences itself when a message is exactly one of them
// (channelBotNoteTabEdits), so each note is a JSON string: the sentence ends where it says it does.
// `id` is the note's `ChannelBotNote.id`; send one only to a server that listed it.
const namedNote = (note: string, id: string | undefined) =>
  JSON.stringify(note) + (id === undefined ? "" : " (note " + id + ")");

export const goatBotForgetNoteMessage = (note: string, id?: string) =>
  "Please forget this note: " + namedNote(note, id);

export const goatBotChangeNoteMessage = (note: string, newText: string, id?: string) =>
  "Please change this note: " + namedNote(note, id) + " to: " + JSON.stringify(newText);
