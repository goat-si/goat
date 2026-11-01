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

/** The hub's current note carried by a revision conflict, or null for any other failure. */
export function noteConflictCurrent(error: unknown): NoteDocument | null {
  if (typeof error !== "object" || error === null) return null;
  if (!("_tag" in error) || error._tag !== "NoteConflictError" || !("current" in error))
    return null;
  return Option.getOrNull(decodeDocument(error.current));
}

export async function deliverNoteWrite(
  input: NotesWriteInput,
  write: (input: NotesWriteInput) => Promise<NoteDocument>,
  read: (path: string) => Promise<NoteDocument>,
): Promise<NoteDelivery> {
  try {
    return { type: "saved", note: await write(input) };
  } catch (error) {
    const current = noteConflictCurrent(error);
    if (current) return { type: "conflict", current };
    if (typeof error === "object" && error !== null) {
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
