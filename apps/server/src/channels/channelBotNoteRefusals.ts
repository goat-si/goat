/**
 * Notes a Memory tab change or forget named while a task held a notes grant. GOAT refused those
 * requests and told the person nothing changed, but the grant's hand edit can still remove the
 * line, for example a tidy that read the refused request. Once every grant open at the refusal
 * has ended, a named line that is no longer in force is written back.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { collapseNoteText, type ChannelBotNoteLine } from "./channelBotNoteLines.ts";
import { channelBotNoteLine } from "./channelBotNotes.ts";

export const RefusedNote = Schema.Struct({
  inputId: Schema.String,
  note: Schema.String,
  /** The new text a refused change asked for. */
  next: Schema.optional(Schema.String),
  /** The line as it stood when the request was refused. */
  line: Schema.String,
  day: Schema.String,
  source: Schema.String,
  /** Tasks whose notes grant was open at the refusal. */
  holders: Schema.Array(Schema.String),
});
export type RefusedNote = typeof RefusedNote.Type;

type RefusedNotesError = SqlError | Schema.SchemaError;

export interface RefusedNotes {
  readonly add: (entry: RefusedNote) => Effect.Effect<void, RefusedNotesError>;
  readonly list: Effect.Effect<ReadonlyArray<RefusedNote>, RefusedNotesError>;
  readonly remove: (inputId: string) => Effect.Effect<void, RefusedNotesError>;
}

const KEY_PREFIX = "notes-refused:";
const encode = Schema.encodeSync(Schema.fromJsonString(RefusedNote));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(RefusedNote));

/** Kept in channel_runtime_state, so a refusal outlives a restart while its grant is still open. */
export const sqlRefusedNotes = (sql: SqlClient.SqlClient): RefusedNotes => ({
  add: (entry) =>
    Effect.flatMap(
      DateTime.now,
      (now) =>
        sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
        VALUES (${KEY_PREFIX + entry.inputId}, ${encode(entry)}, ${DateTime.formatIso(now)})
        ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ),
  list: Effect.flatMap(
    sql<{ readonly value_json: string }>`SELECT value_json FROM channel_runtime_state
      WHERE key >= ${KEY_PREFIX} AND key < ${KEY_PREFIX + "\uffff"} ORDER BY updated_at`,
    (rows) => Effect.forEach(rows, (row) => decode(row.value_json)),
  ),
  remove: (inputId) => sql`DELETE FROM channel_runtime_state WHERE key = ${KEY_PREFIX + inputId}`,
});

/** For a writer built without the ledger's database, as unit tests do. */
export const memoryRefusedNotes = (): RefusedNotes => {
  const entries = new Map<string, RefusedNote>();
  return {
    add: (entry) => Effect.sync(() => void entries.set(entry.inputId, entry)),
    list: Effect.sync(() => [...entries.values()]),
    remove: (inputId) => Effect.sync(() => void entries.delete(inputId)),
  };
};

/** What to record when a tab request naming `note` is refused; nothing when it is not in force. */
export const refusalFor = (
  lines: ReadonlyArray<ChannelBotNoteLine>,
  request: { readonly note: string; readonly next?: string },
  inputId: string,
  readAt: string,
  holders: ReadonlyArray<string>,
): RefusedNote | undefined => {
  const target = lines.find((line) => line.replacedBy === undefined && line.text === request.note);
  if (target === undefined) return undefined;
  return {
    inputId,
    note: request.note,
    ...(request.next === undefined ? {} : { next: request.next }),
    line: target.raw,
    day: target.date ?? readAt,
    source: target.sourceInputId ?? inputId,
    holders: [...holders],
  };
};

/**
 * The lines to append so each refused note is in force again. A refused change whose new text is
 * now in force comes back replacing it, so the newest-wins rule keeps the person's old note.
 */
export const restoredLines = (
  lines: ReadonlyArray<ChannelBotNoteLine>,
  due: ReadonlyArray<RefusedNote>,
) => {
  const inForce = new Set(
    lines
      .filter((line) => line.replacedBy === undefined)
      .map((line) => collapseNoteText(line.text)),
  );
  return due.flatMap((entry) => {
    if (inForce.has(collapseNoteText(entry.note))) return [];
    const replaced = entry.next !== undefined && inForce.has(collapseNoteText(entry.next));
    const line = replaced
      ? channelBotNoteLine(entry.note, entry.day, entry.source, entry.next)
      : entry.line;
    return line === undefined ? [] : [line];
  });
};
