import { NoteOutboxRow, restoreNote } from "@goat/client-runtime/notes";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runtime } from "../../lib/runtime";
import { MobileDatabase } from "../../persistence/mobile-database";
import type { NotesOutboxStorage } from "./outbox-controller";

const decodeRow = Schema.decodeUnknownSync(NoteOutboxRow);

export const notesOutboxStorage: NotesOutboxStorage = {
  load: () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* MobileDatabase;
        const payloads = yield* database.loadNoteOutbox;
        return payloads.map((payload) => restoreNote(decodeRow(JSON.parse(payload))));
      }),
    ),
  save: (row) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* MobileDatabase;
        yield* database.saveNoteOutbox(
          row.environmentId,
          row.path,
          JSON.stringify(row),
          row.localUpdatedAt,
        );
      }),
    ),
  remove: (row) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const database = yield* MobileDatabase;
        yield* database.removeNoteOutbox(row.environmentId, row.path);
      }),
    ),
};
