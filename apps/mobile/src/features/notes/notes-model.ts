import type { NoteOutboxRow } from "@goat/client-runtime/notes";
import type { NoteSummary, NotesEvent, NotesStartWorkInput, NoteThreadLink } from "@goat/contracts";

export interface NotesFeed {
  readonly notes: ReadonlyArray<NoteSummary>;
  readonly truncated: boolean;
  readonly event: NotesEvent | null;
  readonly error?: string;
}
export function applyNotesEvent(state: NotesFeed, event: NotesEvent): NotesFeed {
  if (event.type === "snapshot") return { notes: event.notes, truncated: event.truncated, event };
  return {
    ...state,
    event,
    notes:
      event.type === "removed"
        ? state.notes.filter((note) => note.path !== event.path)
        : [...state.notes.filter((note) => note.path !== event.note.path), event.note],
  };
}
export function noteListRows(
  environmentId: string,
  notes: ReadonlyArray<NoteSummary>,
  outbox: ReadonlyArray<NoteOutboxRow>,
) {
  const rows = new Map(
    notes.map((note) => [
      note.path,
      {
        path: note.path,
        title: note.title,
        folder: note.folder,
        status: note.status,
        pinned: note.pinned === true,
        preview: note.preview ?? "",
        updatedAt: note.updatedAt,
        sync: noteSyncState(),
      },
    ]),
  );
  for (const row of outbox.filter((row) => row.environmentId === environmentId)) {
    const previous = rows.get(row.path);
    rows.set(row.path, {
      path: row.path,
      title:
        /^#\s+(.+)$/m.exec(row.body)?.[1] ??
        previous?.title ??
        row.path.split("/").at(-1)!.slice(0, -3),
      folder: row.path.includes("/") ? row.path.split("/")[0]! : null,
      status: row.status ?? previous?.status ?? "idea",
      pinned: previous?.pinned ?? false,
      preview: previous?.preview ?? "",
      updatedAt: previous?.updatedAt ?? "",
      sync: noteSyncState(row),
    });
  }
  // Same order as web: pinned first, then each folder most recently updated first.
  return [...rows.values()]
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (a.pinned ? 0 : (a.folder ?? "").localeCompare(b.folder ?? "")) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.title.localeCompare(b.title),
    )
    .map((row) => ({ ...row, group: row.pinned ? "Pinned" : (row.folder ?? "Notes") }));
}
export interface NoteWorkAttempt {
  readonly requestId: string;
  readonly input: NotesStartWorkInput | null;
  readonly ambiguous: boolean;
}
export function beginNoteWorkAttempt(requestId: string): NoteWorkAttempt {
  return { requestId, input: null, ambiguous: false };
}
/** Freeze the complete launch payload as well as its key across retries. */
export function captureNoteWorkAttempt(
  attempt: NoteWorkAttempt,
  input: Omit<NotesStartWorkInput, "requestId">,
): NoteWorkAttempt {
  return attempt.input
    ? attempt
    : { ...attempt, input: { ...input, requestId: attempt.requestId } };
}

/** Local drafts remain editable offline; delivery always checks a fresh server grant. */
export function canEditNoteDraft(allowed: boolean, connected: boolean, knownEnvironment: boolean) {
  return allowed || (knownEnvironment && !connected);
}

export function noteSyncState(row?: NoteOutboxRow) {
  if (!row) return "synced" as const;
  if (row.state === "conflict") return "conflict" as const;
  return row.inFlight ? ("syncing" as const) : ("pending" as const);
}

export function noteSyncLabel(state: ReturnType<typeof noteSyncState>) {
  switch (state) {
    case "pending":
      return "Saved on this phone · syncs when connected";
    case "syncing":
      return "Syncing…";
    case "conflict":
      return "Needs your choice";
    case "synced":
      return null;
  }
}

export function noteThreadPresentation(link: NoteThreadLink, title?: string) {
  return {
    label: `${title?.trim() || "Thread"} · ${link.host ?? "This hub"}`,
    // A null result also comes back from a reachable host whose thread has not reported, so it
    // says nothing about the connection.
    status: link.lastResult
      ? `${link.lastResult.runStatus} · ${link.lastResult.outcome ?? "No result reported"}`
      : "No result yet",
  };
}
