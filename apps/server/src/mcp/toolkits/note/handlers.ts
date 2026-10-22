import { readCaller } from "../../threadAccess.ts";
import { type NoteConflictError, type NoteError, OrchestratorMcpFailure } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Notes from "../../../notes/NotesService.ts";
import * as Access from "../../McpToolAccess.ts";
import { NoteToolkit } from "./tools.ts";

const failure = (error: NoteError | NoteConflictError) =>
  new OrchestratorMcpFailure({
    code: error._tag === "NoteConflictError" ? "invalid_request" : "orchestration_error",
    message:
      error._tag === "NoteConflictError"
        ? "Note conflict: read the note again with goat_note_read, apply your edit to the current body, and retry with its revision."
        : error.message,
  });
export const layer = Access.toLayer(NoteToolkit, {
  goat_note_list: Access.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* Notes.NotesService).list(input).pipe(Effect.mapError(failure));
    }),
  ),
  goat_note_read: Access.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* Notes.NotesService).read(input).pipe(Effect.mapError(failure));
    }),
  ),
  goat_note_write: Access.writes((input) =>
    Effect.gen(function* () {
      return yield* (yield* Notes.NotesService)
        .write(input, "agent")
        .pipe(Effect.mapError(failure));
    }),
  ),
  goat_note_update: Access.writes((input) =>
    Effect.gen(function* () {
      return yield* (yield* Notes.NotesService).update(input).pipe(Effect.mapError(failure));
    }),
  ),
  goat_note_move: Access.writes((input) =>
    Effect.gen(function* () {
      return yield* (yield* Notes.NotesService).move(input, "agent").pipe(Effect.mapError(failure));
    }),
  ),
});
