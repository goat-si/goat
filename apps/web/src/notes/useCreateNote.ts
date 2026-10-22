import type { EnvironmentId, NoteDocument, NoteSummary } from "@goat/contracts";
import { useRef } from "react";
import { notesRpc } from "../rpc/notes/atoms";
import { type NoteReply, untitledNotePath } from "./noteState";
import { useNoteCommand } from "./useNoteCommand";

const isTaken = (error: unknown) =>
  typeof error === "object" && error !== null && "reason" in error && error.reason === "exists";

/**
 * Creates Untitled.md (or the next free Untitled N.md) at once, so capture never starts with a
 * file name. Concurrent calls share the one in flight; the guard clears when it settles so the
 * next New note works and a failure can be retried.
 */
export function useCreateNote(environmentId: EnvironmentId, notes: ReadonlyArray<NoteSummary>) {
  const write = useNoteCommand(notesRpc.write);
  const inFlight = useRef<Promise<NoteReply<NoteDocument>> | null>(null);
  const taken = new Set(notes.map((note) => note.path));
  return (folder: string | null = null): Promise<NoteReply<NoteDocument>> => {
    if (inFlight.current) return inFlight.current;
    const attempt = async (): Promise<NoteReply<NoteDocument>> => {
      let result: NoteReply<NoteDocument> = { ok: false, error: null };
      // The list can lag another client's create by a moment; step past names taken since.
      for (let skip = 0; skip < 5; skip++) {
        result = await write({
          environmentId,
          input: { path: untitledNotePath(taken, folder, skip), body: "", baseRevision: null },
        });
        if (result.ok || !isTaken(result.error)) return result;
      }
      return result;
    };
    const pending = attempt().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = pending;
    return pending;
  };
}
