import { NoteDocument, type NotesWriteInput } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { NoteDelivery } from "../outbox-controller";

const decodeDocument = Schema.decodeUnknownOption(NoteDocument);
export function notesError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Notes could not be loaded. Try again when connected.";
}

export async function deliverNoteWrite(
  input: NotesWriteInput,
  write: (input: NotesWriteInput) => Promise<NoteDocument>,
  read: (path: string) => Promise<NoteDocument>,
): Promise<NoteDelivery> {
  try {
    return { type: "saved", note: await write(input) };
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      if ("_tag" in error && error._tag === "NoteConflictError" && "current" in error) {
        const current = decodeDocument(error.current);
        if (Option.isSome(current)) return { type: "conflict", current: current.value };
      }
      // Offline creation can race another creator. Comparing must still be an explicit choice.
      if (
        "_tag" in error &&
        error._tag === "NoteError" &&
        "reason" in error &&
        error.reason === "exists"
      ) {
        try {
          return { type: "conflict", current: await read(input.path) };
        } catch (readError) {
          return { type: "retry", message: notesError(readError) };
        }
      }
    }
    return { type: "retry", message: notesError(error) };
  }
}
