import type { EnvironmentId, NoteDocument, NotesWriteInput } from "@goat/contracts";
import {
  NoteDocument as NoteDocumentSchema,
  NotePath,
  NoteRevision,
  NoteStatus,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

const SentEdit = Schema.Struct({
  body: Schema.String,
  status: Schema.optional(NoteStatus),
  baseRevision: Schema.NullOr(NoteRevision),
  localUpdatedAt: Schema.Number,
});

export const NoteOutboxRow = Schema.Struct({
  environmentId: Schema.String,
  // Rows outlive app versions. Enqueueing validates the path and the hub refuses an invalid one on
  // send, so a draft saved under an older, looser NotePath stays visible without blocking the rest.
  path: Schema.String,
  ...SentEdit.fields,
  state: Schema.Literals(["pending", "conflict"]),
  // Likewise, a title saved before the wire cap must not block the outbox.
  current: Schema.NullOr(Schema.Struct({ ...NoteDocumentSchema.fields, title: Schema.String })),
  inFlight: Schema.NullOr(SentEdit),
});
export type NoteOutboxRow = typeof NoteOutboxRow.Type;
export type NoteEdit = NotesWriteInput & {
  readonly environmentId: EnvironmentId;
  readonly localUpdatedAt: number;
};

const decodeNotePath = Schema.decodeSync(NotePath);

export function noteOutboxKey(environmentId: string, path: string): string {
  return JSON.stringify([environmentId, path.normalize("NFC")]);
}

export function enqueueNote(
  rows: ReadonlyArray<NoteOutboxRow>,
  edit: NoteEdit,
): ReadonlyArray<NoteOutboxRow> {
  const path = decodeNotePath(edit.path.normalize("NFC"));
  const key = noteOutboxKey(edit.environmentId, path);
  const previous = rows.find((row) => noteOutboxKey(row.environmentId, row.path) === key);
  const next: NoteOutboxRow = {
    ...edit,
    path,
    status: edit.status ?? previous?.status,
    baseRevision: previous ? previous.baseRevision : edit.baseRevision,
    localUpdatedAt: Math.max(edit.localUpdatedAt, (previous?.localUpdatedAt ?? -1) + 1),
    state: previous?.state ?? "pending",
    current: previous?.current ?? null,
    inFlight: previous?.inFlight ?? null,
  };
  return [...rows.filter((row) => noteOutboxKey(row.environmentId, row.path) !== key), next];
}

export function markNoteInFlight(row: NoteOutboxRow): NoteOutboxRow {
  if (row.state === "conflict" || row.inFlight) return row;
  return {
    ...row,
    inFlight: {
      body: row.body,
      status: row.status,
      baseRevision: row.baseRevision,
      localUpdatedAt: row.localUpdatedAt,
    },
  };
}

/** An older response must neither erase a newer edit nor acknowledge a different send. */
export function acknowledgeNote(
  row: NoteOutboxRow,
  sentVersion: number,
  revision: string,
): NoteOutboxRow | null {
  if (row.inFlight?.localUpdatedAt !== sentVersion) return row;
  if (row.localUpdatedAt === sentVersion) return null;
  return { ...row, baseRevision: revision, inFlight: null };
}

export function conflictNote(row: NoteOutboxRow, current: NoteDocument): NoteOutboxRow {
  return { ...row, state: "conflict", current, inFlight: null };
}

export function resolveNote(row: NoteOutboxRow, choice: "theirs" | "mine"): NoteOutboxRow | null {
  if (row.state !== "conflict" || row.current === null) return row;
  return choice === "theirs"
    ? null
    : {
        ...row,
        baseRevision: row.current.revision,
        state: "pending",
        current: null,
        inFlight: null,
      };
}

/** A process cannot resume an in-memory request; replay uses optimistic concurrency. */
export function restoreNote(row: NoteOutboxRow): NoteOutboxRow {
  return { ...row, inFlight: null };
}

export function noteWriteInput(row: NoteOutboxRow): NotesWriteInput {
  const edit = row.inFlight ?? row;
  return { path: row.path, body: edit.body, status: edit.status, baseRevision: edit.baseRevision };
}
