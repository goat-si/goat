import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@goat/contracts";
import {
  applyNotesEvent,
  canEditNoteDraft,
  beginNoteWorkAttempt,
  captureNoteWorkAttempt,
  noteListRows,
  noteSyncState,
  noteSyncLabel,
  type NotesFeed,
} from "./notes-model";
import { document, row } from "./test-fixtures";

const empty: NotesFeed = { notes: [], truncated: false, event: null };
describe("notes screen state", () => {
  it("applies snapshot, upserts and removals without duplicating a path", () => {
    const note = document();
    const snapshot = applyNotesEvent(empty, {
      type: "snapshot",
      notes: [note],
      folders: [],
      truncated: true,
    });
    const updated = applyNotesEvent(snapshot, {
      type: "upserted",
      note: { ...note, status: "done" },
    });
    expect(updated.notes).toHaveLength(1);
    expect(updated.notes[0]!.status).toBe("done");
    expect(updated.truncated).toBe(true);
    expect(applyNotesEvent(updated, { type: "removed", path: note.path }).notes).toEqual([]);
  });
  it("overlays offline notes only for their owning environment and groups by folder", () => {
    const rows = noteListRows(
      "hub",
      [document()],
      [
        row(),
        {
          ...row(),
          path: "project/idea.md",
          body: "# Draft",
          status: "doing",
          state: "conflict",
          current: document(),
        },
        { ...row(), environmentId: "another", path: "hidden.md" },
      ],
    );
    expect(rows.map((row) => [row.path, row.title, row.sync, row.status])).toEqual([
      ["note.md", "Note", "pending", "idea"],
      ["project/idea.md", "Draft", "conflict", "doing"],
    ]);
  });
  it("lists pinned notes first, then each folder most recently updated first", () => {
    const note = (path: string, updatedAt: string, pinned = false) => ({
      ...document(),
      path,
      folder: path.includes("/") ? path.split("/")[0]! : null,
      title: path,
      updatedAt,
      pinned,
    });
    const rows = noteListRows(
      "hub",
      [
        note("b/old.md", "2026-10-01T00:00:00.000Z"),
        note("b/new.md", "2026-10-20T00:00:00.000Z"),
        note("a/one.md", "2026-10-02T00:00:00.000Z"),
        note("z/pinned.md", "2026-09-01T00:00:00.000Z", true),
      ],
      [],
    );
    expect(rows.map((row) => [row.group, row.path])).toEqual([
      ["Pinned", "z/pinned.md"],
      ["a", "a/one.md"],
      ["b", "b/new.md"],
      ["b", "b/old.md"],
    ]);
  });
  it("freezes request id and full launch payload on retry, even if form choices change", () => {
    const attempt = captureNoteWorkAttempt(beginNoteWorkAttempt("attempt-1"), {
      path: "note.md",
      target: { type: "hub", projectId: ProjectId.make("project") },
    });
    const retry = captureNoteWorkAttempt(attempt, {
      path: "other.md",
      target: { type: "host", host: "studio", projectPath: "/work" },
    });
    expect(retry).toBe(attempt);
    expect(retry.input?.requestId).toBe("attempt-1");
    expect(retry.input?.target.type).toBe("hub");
    expect(beginNoteWorkAttempt("explicit-start-again")).toEqual({
      requestId: "explicit-start-again",
      input: null,
      ambiguous: false,
    });
  });
});

it("permits local drafts offline while connected read-only access stays read-only", () => {
  expect(canEditNoteDraft(false, false, true)).toBe(true);
  expect(canEditNoteDraft(false, true, true)).toBe(false);
  expect(canEditNoteDraft(false, false, false)).toBe(false);
  expect(canEditNoteDraft(true, true, true)).toBe(true);
});

describe("note sync presentation", () => {
  it("distinguishes saved, sending, conflicted and acknowledged edits", () => {
    const pending = row();
    const sending = { ...pending, inFlight: pending };
    const conflict = { ...sending, state: "conflict" as const };
    expect(noteSyncLabel(noteSyncState(pending))).toBe(
      "Saved on this phone · syncs when connected",
    );
    expect(noteSyncLabel(noteSyncState(sending))).toBe("Syncing…");
    expect(noteSyncLabel(noteSyncState(conflict))).toBe("Needs your choice");
    expect(noteSyncLabel(noteSyncState())).toBeNull();
    expect(noteListRows("hub", [document()], [sending])[0]?.sync).toBe("syncing");
    expect(noteListRows("hub", [document()], [conflict])[0]?.sync).toBe("conflict");
    expect(noteListRows("hub", [document()], [])[0]?.sync).toBe("synced");
  });
});
