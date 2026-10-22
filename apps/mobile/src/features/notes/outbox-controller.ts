import {
  acknowledgeNote,
  conflictNote,
  enqueueNote,
  markNoteInFlight,
  noteOutboxKey,
  noteWriteInput,
  resolveNote,
  restoreNote,
  type NoteEdit,
  type NoteOutboxRow,
} from "@goat/client-runtime/notes";
import type { NoteDocument, NotesWriteInput } from "@goat/contracts";

export interface NotesOutboxStorage {
  readonly load: () => Promise<ReadonlyArray<NoteOutboxRow>>;
  readonly save: (row: NoteOutboxRow) => Promise<void>;
  readonly remove: (row: NoteOutboxRow) => Promise<void>;
}

export type NoteDelivery =
  | { readonly type: "saved"; readonly note: NoteDocument }
  | { readonly type: "conflict"; readonly current: NoteDocument }
  | { readonly type: "retry"; readonly message: string };

/** Serialize disk mutations, but let edits persist while a network request is in flight. */
export function createNotesOutboxController(storage: NotesOutboxStorage) {
  let rows: ReadonlyArray<NoteOutboxRow> = [];
  let ready: Promise<void> | undefined;
  let writes = Promise.resolve();
  const listeners = new Set<() => void>();
  const flushing = new Map<string, Promise<void>>();
  const errors = new Map<string, string>();
  const changedDuringFlush = new Set<string>();
  const requestedDuringFlush = new Map<string, number>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const serialize = <A>(run: () => Promise<A>) => {
    const result = writes.then(run);
    writes = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const restore = () =>
    (ready ??= storage
      .load()
      .then((loaded) => {
        rows = loaded.map(restoreNote);
        emit();
      })
      .catch((error: unknown) => {
        ready = undefined;
        throw error;
      }));
  const replace = async (before: NoteOutboxRow, after: NoteOutboxRow | null) => {
    if (after) await storage.save(after);
    else await storage.remove(before);
    const key = noteOutboxKey(before.environmentId, before.path);
    rows = rows.filter((row) => noteOutboxKey(row.environmentId, row.path) !== key);
    if (after) rows = [...rows, after];
    emit();
  };
  const find = (environmentId: string, path: string) =>
    rows.find(
      (row) => noteOutboxKey(row.environmentId, row.path) === noteOutboxKey(environmentId, path),
    );
  return {
    restore,
    getSnapshot: () => rows,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    error: (environmentId: string) => errors.get(environmentId),
    async enqueue(edit: NoteEdit) {
      await restore();
      await serialize(async () => {
        const merged = enqueueNote(rows, edit);
        const next = merged.find(
          (row) =>
            noteOutboxKey(row.environmentId, row.path) ===
            noteOutboxKey(edit.environmentId, edit.path),
        )!;
        await storage.save(next);
        rows = merged;
        if (flushing.has(edit.environmentId)) changedDuringFlush.add(edit.environmentId);
        emit();
      });
    },
    async discard(environmentId: string, path: string, version: number) {
      await restore();
      return serialize(async () => {
        const row = find(environmentId, path);
        if (!row || row.inFlight || row.localUpdatedAt !== version) return false;
        await replace(row, null);
        return true;
      });
    },
    async resolve(environmentId: string, path: string, choice: "mine" | "theirs") {
      await restore();
      await serialize(async () => {
        const row = find(environmentId, path);
        if (row) {
          await replace(row, resolveNote(row, choice));
          if (choice === "mine" && flushing.has(environmentId))
            changedDuringFlush.add(environmentId);
        }
      });
    },
    flush(
      environmentId: string,
      send: (input: NotesWriteInput) => Promise<NoteDelivery>,
      canSend: () => boolean,
      connectionGeneration = 0,
    ): Promise<void> {
      const existing = flushing.get(environmentId);
      if (existing) {
        requestedDuringFlush.set(
          environmentId,
          Math.max(connectionGeneration, requestedDuringFlush.get(environmentId) ?? 0),
        );
        return existing;
      }
      const drain = async () => {
        await restore();
        errors.delete(environmentId);
        await serialize(async () => {
          for (const row of rows.filter(
            (row) => row.environmentId === environmentId && row.inFlight,
          )) {
            await replace(row, { ...row, inFlight: null });
          }
        });
        const attempted = new Set<string>();
        while (canSend()) {
          const sent = await serialize(async () => {
            const row = rows.find(
              (candidate) =>
                candidate.environmentId === environmentId &&
                candidate.state === "pending" &&
                !candidate.inFlight &&
                !attempted.has(candidate.path),
            );
            if (!row) return null;
            const marked = markNoteInFlight(row);
            await replace(row, marked);
            return marked;
          });
          if (!sent || !canSend()) {
            if (sent)
              await serialize(async () => {
                const row = find(environmentId, sent.path);
                if (row) await replace(row, { ...row, inFlight: null });
              });
            break;
          }
          let result: NoteDelivery;
          try {
            result = await send(noteWriteInput(sent));
          } catch (error) {
            result = {
              type: "retry",
              message: error instanceof Error ? error.message : "Note could not sync.",
            };
          }
          const delivery = result;
          await serialize(async () => {
            const row = find(environmentId, sent.path);
            if (!row) return;
            if (delivery.type === "saved")
              await replace(
                row,
                acknowledgeNote(row, sent.inFlight!.localUpdatedAt, delivery.note.revision),
              );
            else if (delivery.type === "conflict")
              await replace(row, conflictNote(row, delivery.current));
            else {
              errors.set(environmentId, delivery.message);
              await replace(row, { ...row, inFlight: null });
            }
          });
          if (result.type !== "saved") attempted.add(sent.path);
        }
        emit();
      };
      const run = async () => {
        const replayedGenerations = new Set<number>();
        do {
          changedDuringFlush.delete(environmentId);
          requestedDuringFlush.delete(environmentId);
          await drain();
          const generation = requestedDuringFlush.get(environmentId);
          const requested = generation !== undefined && !replayedGenerations.has(generation);
          if (!changedDuringFlush.has(environmentId) && !requested) break;
          // Bound repeated manual triggers per connection while preserving later reconnects.
          if (requested) replayedGenerations.add(generation);
        } while (canSend());
      };
      const promise = run().finally(() => {
        flushing.delete(environmentId);
        requestedDuringFlush.delete(environmentId);
      });
      flushing.set(environmentId, promise);
      return promise;
    },
  };
}
