import {
  NoteConflictError,
  type NoteDocument,
  type NotesEvent,
  type NotesListResult,
  type NoteStatus,
  type NotesWriteInput,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

const isConflict = Schema.is(NoteConflictError);

export const emptyNotes: NotesListResult = { notes: [], folders: [], truncated: false };
export function reduceNotes(state: NotesListResult, event: NotesEvent): NotesListResult {
  if (event.type === "snapshot")
    return { notes: event.notes, folders: event.folders, truncated: event.truncated };
  const notes = state.notes.filter(
    (note) => note.path !== (event.type === "removed" ? event.path : event.note.path),
  );
  if (event.type === "upserted") notes.push(event.note);
  notes.sort((left, right) => left.path.localeCompare(right.path));
  return {
    ...state,
    notes,
    folders: [
      ...new Set(notes.flatMap((note) => (note.folder === null ? [] : [note.folder]))),
    ].sort(),
  };
}

export type NoteReply<A> = { ok: true; value: A } | { ok: false; error: unknown };
export function noteErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
      ? error.message
      : "The note request failed. Try again.";
}
export function isAmbiguousLaunch(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason === "launch_ambiguous"
  );
}

export interface NoteEditState {
  document: NoteDocument;
  body: string;
  status: NoteStatus;
  incoming: NoteDocument | null;
  saving: boolean;
  refreshing: boolean;
  refreshError: string | null;
  error: string | null;
  editorVersion: number;
}
export function isNoteDirty(state: NoteEditState): boolean {
  return state.body !== state.document.body || state.status !== state.document.status;
}

// Save acknowledgements advance the base, never replace edits typed while the request was in flight.
export class NoteSession {
  private state: NoteEditState;
  private listeners = new Set<() => void>();
  private readSequence = 0;
  constructor(
    document: NoteDocument,
    private write: (input: NotesWriteInput) => Promise<NoteReply<NoteDocument>>,
  ) {
    this.state = {
      document,
      body: document.body,
      status: document.status,
      incoming: null,
      saving: false,
      refreshing: false,
      refreshError: null,
      error: null,
      editorVersion: 0,
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(next: NoteEditState) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  edit(body: string, status = this.state.status) {
    this.update({ ...this.state, body, status, error: null });
  }
  receive(document: NoteDocument) {
    const state = this.state;
    if (document.revision === state.document.revision) {
      this.update({ ...state, document, refreshError: null });
    } else if (isNoteDirty(state) || state.saving) {
      this.update({ ...state, incoming: document });
    } else {
      this.update({
        ...state,
        document,
        body: document.body,
        status: document.status,
        incoming: null,
        editorVersion: state.editorVersion + 1,
        error: null,
      });
    }
  }
  async refresh(read: () => Promise<NoteReply<NoteDocument>>) {
    const sequence = ++this.readSequence;
    const baseRevision = this.state.document.revision;
    this.update({ ...this.state, refreshing: true, refreshError: null });
    const result = await read().catch((error: unknown): NoteReply<NoteDocument> => ({
      ok: false,
      error,
    }));
    // A save acknowledged after this read began owns the newer base. Read again so an
    // intervening external edit is still seen, without trusting a response from the old base.
    if (sequence !== this.readSequence) return;
    this.update({ ...this.state, refreshing: false });
    if (baseRevision !== this.state.document.revision) {
      if (!result.ok || result.value.revision !== this.state.document.revision)
        await this.refresh(read);
      return;
    }
    if (result.ok) this.receive(result.value);
    else this.update({ ...this.state, refreshError: noteErrorMessage(result.error) });
  }
  compare(current: NoteDocument) {
    this.update({ ...this.state, incoming: current, error: null });
  }
  acceptTheirs() {
    if (!this.state.incoming || this.state.saving) return;
    const document = this.state.incoming;
    this.update({
      ...this.state,
      document,
      body: document.body,
      status: document.status,
      incoming: null,
      error: null,
      editorVersion: this.state.editorVersion + 1,
    });
  }
  async keepMine() {
    if (!this.state.incoming || this.state.saving) return;
    this.update({ ...this.state, document: this.state.incoming, incoming: null, error: null });
    await this.save();
  }
  async save(expected?: Pick<NoteEditState, "body" | "status">) {
    const before = this.state;
    if (
      before.saving ||
      before.incoming ||
      !isNoteDirty(before) ||
      (expected && (expected.body !== before.body || expected.status !== before.status))
    )
      return;
    const input = {
      path: before.document.path,
      body: before.body,
      status: before.status,
      baseRevision: before.document.revision,
    };
    this.update({ ...before, saving: true, error: null });
    const result = await this.write(input).catch((error: unknown): NoteReply<NoteDocument> => ({
      ok: false,
      error,
    }));
    const latest = this.state;
    if (result.ok) {
      this.update({
        ...latest,
        document: result.value,
        saving: false,
        incoming: latest.incoming?.revision === result.value.revision ? null : latest.incoming,
      });
    } else {
      this.update({
        ...latest,
        saving: false,
        incoming: isConflict(result.error) ? result.error.current : latest.incoming,
        error: isConflict(result.error) ? null : noteErrorMessage(result.error),
      });
    }
  }
}

export type NoteLineChange = { type: "same" | "removed" | "added"; text: string };
const MAX_DIFF_LINES = 2000;
const MAX_DIFF_CELLS = 250_000;
const MAX_DIFF_CHARACTER_WORK = 4_000_000;

export function compareNoteLines(theirs: string, mine: string): NoteLineChange[] {
  const left = theirs.split("\n");
  const right = mine.split("\n");
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let endLeft = left.length;
  let endRight = right.length;
  while (endLeft > prefix && endRight > prefix && left[endLeft - 1] === right[endRight - 1]) {
    endLeft--;
    endRight--;
  }
  const changes = left.slice(0, prefix).map((text): NoteLineChange => ({ type: "same", text }));
  const rows = endLeft - prefix;
  const columns = endRight - prefix;
  let leftCharacters = 0;
  let rightCharacters = 0;
  for (let row = prefix; row < endLeft; row++) leftCharacters += left[row]!.length;
  for (let column = prefix; column < endRight; column++) rightCharacters += right[column]!.length;
  // Equality can scan long shared prefixes, so cell count alone cannot bound the UI work.
  if (
    left.length > MAX_DIFF_LINES ||
    right.length > MAX_DIFF_LINES ||
    rows * columns > MAX_DIFF_CELLS ||
    columns * leftCharacters + rows * rightCharacters > MAX_DIFF_CHARACTER_WORK
  ) {
    for (let row = prefix; row < endLeft; row++)
      changes.push({ type: "removed", text: left[row]! });
    for (let column = prefix; column < endRight; column++)
      changes.push({ type: "added", text: right[column]! });
  } else {
    const stride = columns + 1;
    const lengths = new Uint16Array((rows + 1) * stride);
    for (let row = rows - 1; row >= 0; row--) {
      for (let column = columns - 1; column >= 0; column--) {
        lengths[row * stride + column] =
          left[prefix + row] === right[prefix + column]
            ? 1 + lengths[(row + 1) * stride + column + 1]!
            : Math.max(lengths[(row + 1) * stride + column]!, lengths[row * stride + column + 1]!);
      }
    }
    let row = 0;
    let column = 0;
    while (row < rows || column < columns) {
      if (row < rows && column < columns && left[prefix + row] === right[prefix + column]) {
        changes.push({ type: "same", text: left[prefix + row++]! });
        column++;
      } else if (
        row < rows &&
        (column === columns ||
          lengths[(row + 1) * stride + column]! >= lengths[row * stride + column + 1]!)
      ) {
        changes.push({ type: "removed", text: left[prefix + row++]! });
      } else {
        changes.push({ type: "added", text: right[prefix + column++]! });
      }
    }
  }
  for (const text of left.slice(endLeft)) changes.push({ type: "same", text });
  return changes;
}

export const emptyNoteIndex = { ...emptyNotes, ready: false, removedPaths: new Set<string>() };
export function reduceNoteIndex(
  state: typeof emptyNoteIndex,
  event: NotesEvent,
): typeof emptyNoteIndex {
  const removedPaths = new Set(state.removedPaths);
  if (event.type === "removed") removedPaths.add(event.path);
  else if (event.type === "upserted") removedPaths.delete(event.note.path);
  else {
    const present = new Set(event.notes.map((note) => note.path));
    for (const note of state.notes)
      if (!event.truncated && !present.has(note.path)) removedPaths.add(note.path);
    for (const path of present) removedPaths.delete(path);
  }
  return {
    ...reduceNotes(state, event),
    ready: state.ready || event.type === "snapshot",
    removedPaths,
  };
}
