import type { NotesEvent } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { applyNotesEvent, type NotesFeed } from "../notes-model";

export interface NotesSession {
  readonly subscribe: () => Stream.Stream<NotesEvent, unknown>;
}

/** Keep watching sessions after a transport error, and reset the list on each new snapshot. */
export function followNotesSessions<E, R>(
  sessions: Stream.Stream<Option.Option<NotesSession>, E, R>,
) {
  return sessions.pipe(
    Stream.switchMap(
      Option.match({
        onNone: () => Stream.empty,
        onSome: (session) =>
          session.subscribe().pipe(
            Stream.scan(
              (): NotesFeed => ({ notes: [], truncated: false, event: null }),
              applyNotesEvent,
            ),
            Stream.catch((error) =>
              Stream.succeed<NotesFeed>({
                notes: [],
                truncated: false,
                event: null,
                error:
                  error instanceof Error
                    ? error.message
                    : "The notes subscription failed. Reconnect to try again.",
              }),
            ),
          ),
      }),
    ),
  );
}
