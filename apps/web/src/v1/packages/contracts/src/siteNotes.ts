import * as Schema from "effect/Schema";

export const SiteNoteOriginInput = Schema.Struct({ origin: Schema.String });
export const SiteNoteWriteInput = Schema.Struct({ origin: Schema.String, text: Schema.String });
export const SiteNoteListEntry = Schema.Struct({
  origin: Schema.String,
  text: Schema.String,
  author: Schema.Literals(["agent", "person", "seed"]),
  updatedAt: Schema.NullOr(Schema.String),
  seed: Schema.Boolean,
  hidden: Schema.Boolean,
});
export type SiteNoteListEntry = typeof SiteNoteListEntry.Type;
