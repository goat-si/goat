import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

/** One line of GOAT Bot's notes file. `date` is null for a line a person or worker wrote by hand. */
export const ChannelBotNote = Schema.Struct({
  /** Position among the lines read, oldest first, so a client can key rows. */
  index: NonNegativeInt,
  /** `YYYY-MM-DD`. */
  date: Schema.NullOr(Schema.String),
  text: Schema.String,
  /** The text of the earlier note this line replaced. */
  replaces: Schema.optionalKey(Schema.String),
  /** `index` of the later line that replaced this note; such a note no longer applies. */
  replacedBy: Schema.optionalKey(NonNegativeInt),
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

// Reception keeps a change or forget request only when the person's message quotes the note
// (ChannelReceptionService), so these quote the note text exactly, without escaping.
export const goatBotForgetNoteMessage = (note: string) => 'Please forget this note: "' + note + '"';

export const goatBotChangeNoteMessage = (note: string, newText: string) =>
  'Please change this note: "' + note + '" to: "' + newText + '"';
