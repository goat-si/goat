import { NoteConflictError, type NoteDocument, type NotesWriteInput } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  compareNoteLines,
  emptyNotes,
  emptyNoteIndex,
  reduceNoteIndex,
  isAmbiguousLaunch,
  isNoteDirty,
  NoteSession,
  reduceNotes,
  type NoteReply,
} from "./noteState";

const document = (body = "Original", revision = "a".repeat(64)): NoteDocument => ({
  path: "project/idea.md",
  folder: "project",
  title: "Idea",
  body,
  status: "idea",
  threads: [],
  updatedBy: "user",
  revision,
  updatedAt: "2026-10-19T00:00:00.000Z",
  size: body.length,
});
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("note edit session", () => {
  it("keeps edits made during a save and advances their base revision", async () => {
    const response = deferred<NoteReply<NoteDocument>>();
    const write = vi
      .fn<(input: NotesWriteInput) => Promise<NoteReply<NoteDocument>>>()
      .mockReturnValueOnce(response.promise)
      .mockImplementation(async (input) => ({
        ok: true,
        value: { ...document(input.body, "c".repeat(64)), status: input.status ?? "idea" },
      }));
    const session = new NoteSession(document(), write);
    session.edit("First edit");
    const saving = session.save();
    session.edit("Second edit", "doing");
    await session.save();
    expect(write).toHaveBeenCalledTimes(1);
    response.resolve({ ok: true, value: document("First edit", "b".repeat(64)) });
    await saving;
    expect(session.getSnapshot().body).toBe("Second edit");
    expect(isNoteDirty(session.getSnapshot())).toBe(true);
    await session.save();
    expect(write.mock.calls[1]?.[0]).toMatchObject({
      baseRevision: "b".repeat(64),
      body: "Second edit",
      status: "doing",
    });
    expect(isNoteDirty(session.getSnapshot())).toBe(false);
  });
  it("keeps an incoming external edit separate and pauses saving until compare", async () => {
    const write = vi.fn();
    const session = new NoteSession(document(), write);
    session.edit("Mine");
    session.receive(document("Theirs", "b".repeat(64)));
    await session.save();
    expect(write).not.toHaveBeenCalled();
    expect(session.getSnapshot().body).toBe("Mine");
    session.acceptTheirs();
    expect(session.getSnapshot().body).toBe("Theirs");
    expect(isNoteDirty(session.getSnapshot())).toBe(false);
    expect(session.getSnapshot().editorVersion).toBe(1);
  });
  it("uses the conflict revision for Keep mine and compares again on a second conflict", async () => {
    const theirs = document("Theirs", "b".repeat(64));
    const newer = document("Changed again", "c".repeat(64));
    const write = vi
      .fn<(input: NotesWriteInput) => Promise<NoteReply<NoteDocument>>>()
      .mockResolvedValueOnce({
        ok: false,
        error: new NoteConflictError({ path: theirs.path, current: theirs, message: "Changed" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        error: new NoteConflictError({
          path: newer.path,
          current: newer,
          message: "Changed again",
        }),
      });
    const session = new NoteSession(document(), write);
    session.edit("Mine");
    await session.save();
    expect(session.getSnapshot().incoming).toEqual(theirs);
    await session.keepMine();
    expect(write.mock.calls[1]?.[0]).toMatchObject({ baseRevision: theirs.revision, body: "Mine" });
    expect(session.getSnapshot().incoming).toEqual(newer);
    expect(session.getSnapshot().body).toBe("Mine");
  });
  it("refreshes a clean editor and updates metadata without resetting selection for the same revision", () => {
    const session = new NoteSession(document(), vi.fn());
    session.receive(document("Agent change", "b".repeat(64)));
    expect(session.getSnapshot().body).toBe("Agent change");
    expect(session.getSnapshot().editorVersion).toBe(1);
    session.receive({ ...document("Agent change", "b".repeat(64)), title: "Renamed" });
    expect(session.getSnapshot().editorVersion).toBe(1);
    expect(session.getSnapshot().document.title).toBe("Renamed");
  });
  it("does not mistake its own streamed write for an unresolved conflict", async () => {
    const result = deferred<NoteReply<NoteDocument>>();
    const session = new NoteSession(document(), () => result.promise);
    session.edit("Mine");
    const saving = session.save();
    const saved = document("Mine", "b".repeat(64));
    session.receive(saved);
    result.resolve({ ok: true, value: saved });
    await saving;
    expect(session.getSnapshot().incoming).toBe(null);
    expect(isNoteDirty(session.getSnapshot())).toBe(false);
  });
  it("ignores a read begun before a save acknowledgement without rejecting a later exact revert", async () => {
    const reply = deferred<NoteReply<NoteDocument>>();
    const saved = document("Mine", "b".repeat(64));
    const session = new NoteSession(document(), async () => ({ ok: true, value: saved }));
    const read = vi
      .fn<() => Promise<NoteReply<NoteDocument>>>()
      .mockReturnValueOnce(reply.promise)
      .mockResolvedValueOnce({ ok: true, value: saved });
    const refreshing = session.refresh(read);
    session.edit("Mine");
    await session.save();
    reply.resolve({ ok: true, value: document() });
    await refreshing;
    expect(session.getSnapshot().body).toBe("Mine");
    await session.refresh(async () => ({ ok: true, value: document() }));
    expect(session.getSnapshot().body).toBe("Original");
  });
  it("re-reads an external update whose response crossed a save acknowledgement", async () => {
    const reply = deferred<NoteReply<NoteDocument>>();
    const external = document("External after save", "c".repeat(64));
    const saved = document("Mine", "b".repeat(64));
    const session = new NoteSession(document(), async () => ({ ok: true, value: saved }));
    session.edit("Mine");
    const read = vi
      .fn<() => Promise<NoteReply<NoteDocument>>>()
      .mockReturnValueOnce(reply.promise)
      .mockResolvedValueOnce({ ok: true, value: external });
    const refreshing = session.refresh(read);
    await session.save();
    reply.resolve({ ok: true, value: external });
    await refreshing;
    expect(read).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().body).toBe(external.body);
  });
  it("ignores out-of-order external reads", async () => {
    const older = deferred<NoteReply<NoteDocument>>();
    const session = new NoteSession(document(), vi.fn());
    const first = session.refresh(() => older.promise);
    await session.refresh(async () => ({ ok: true, value: document("Newest", "c".repeat(64)) }));
    older.resolve({ ok: true, value: document("Older", "b".repeat(64)) });
    await first;
    expect(session.getSnapshot().body).toBe("Newest");
  });
  it("does not send an autosave scheduled for an obsolete draft", async () => {
    const send = vi.fn();
    const session = new NoteSession(document(), send);
    session.edit("First");
    session.edit("Second");
    await session.save({ body: "First", status: "idea" });
    expect(send).not.toHaveBeenCalled();
  });
  it("lets a stale rename or delete compare the current file before discarding the old body", () => {
    const session = new NoteSession(document(), vi.fn());
    session.compare(document("Changed before rename", "b".repeat(64)));
    expect(session.getSnapshot().body).toBe("Original");
    expect(session.getSnapshot().incoming?.body).toBe("Changed before rename");
    session.acceptTheirs();
    expect(session.getSnapshot().body).toBe("Changed before rename");
  });
  it("moves a draft onto a pin or link change without asking to compare", () => {
    const session = new NoteSession(document(), vi.fn());
    session.edit("Mine");
    session.receive({ ...document("Original", "b".repeat(64)), pinned: true });
    expect(session.getSnapshot().incoming).toBe(null);
    expect(session.getSnapshot().document.revision).toBe("b".repeat(64));
    expect(session.getSnapshot().body).toBe("Mine");
  });
  it("rereads after a save when a pin made before the save arrives first", async () => {
    const reply = deferred<NoteReply<NoteDocument>>();
    const saved = document("Mine", "c".repeat(64));
    const read = vi.fn(async (): Promise<NoteReply<NoteDocument>> => ({ ok: true, value: saved }));
    const session = new NoteSession(document(), () => reply.promise, read);
    session.edit("Mine");
    const saving = session.save();
    session.receive({ ...document("Original", "b".repeat(64)), pinned: true });
    reply.resolve({ ok: true, value: saved });
    await saving;
    expect(read).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().incoming).toBe(null);
    expect(session.getSnapshot().document.revision).toBe(saved.revision);
    expect(isNoteDirty(session.getSnapshot())).toBe(false);
  });
  it("adopts a pin made after the save without prompting and keeps later typing", async () => {
    const reply = deferred<NoteReply<NoteDocument>>();
    const saved = document("Mine", "c".repeat(64));
    const pinnedAfter = { ...document("Mine", "d".repeat(64)), pinned: true };
    const read = vi.fn(async (): Promise<NoteReply<NoteDocument>> => ({
      ok: true,
      value: pinnedAfter,
    }));
    const session = new NoteSession(document(), () => reply.promise, read);
    session.edit("Mine");
    const saving = session.save();
    session.receive(pinnedAfter);
    session.edit("Mine, then more");
    reply.resolve({ ok: true, value: saved });
    await saving;
    expect(session.getSnapshot().incoming).toBe(null);
    expect(session.getSnapshot().document.revision).toBe(pinnedAfter.revision);
    expect(session.getSnapshot().body).toBe("Mine, then more");
  });
  it("still asks to compare when another writer changed the body during the save", async () => {
    const reply = deferred<NoteReply<NoteDocument>>();
    const theirs = document("Theirs", "d".repeat(64));
    const read = vi.fn(async (): Promise<NoteReply<NoteDocument>> => ({ ok: true, value: theirs }));
    const session = new NoteSession(document(), () => reply.promise, read);
    session.edit("Mine");
    const saving = session.save();
    session.receive(theirs);
    session.edit("Mine again");
    reply.resolve({ ok: true, value: document("Mine", "c".repeat(64)) });
    await saving;
    expect(session.getSnapshot().incoming).toEqual(theirs);
    expect(session.getSnapshot().body).toBe("Mine again");
  });
  it("retries once on a conflict caused only by a header change", async () => {
    const pinned = { ...document("Original", "b".repeat(64)), pinned: true };
    const write = vi
      .fn<(input: NotesWriteInput) => Promise<NoteReply<NoteDocument>>>()
      .mockResolvedValueOnce({
        ok: false,
        error: new NoteConflictError({ path: pinned.path, current: pinned, message: "Changed" }),
      })
      .mockResolvedValueOnce({ ok: true, value: document("Mine", "c".repeat(64)) });
    const session = new NoteSession(document(), write);
    session.edit("Mine");
    await session.save();
    expect(write.mock.calls[1]?.[0].baseRevision).toBe(pinned.revision);
    expect(session.getSnapshot().incoming).toBe(null);
    expect(isNoteDirty(session.getSnapshot())).toBe(false);
  });
  it("preserves the draft on transport failure and retries with the original revision", async () => {
    const write = vi
      .fn<(input: NotesWriteInput) => Promise<NoteReply<NoteDocument>>>()
      .mockRejectedValueOnce(new Error("Disconnected"))
      .mockResolvedValueOnce({ ok: true, value: document("Mine", "b".repeat(64)) });
    const session = new NoteSession(document(), write);
    session.edit("Mine");
    await session.save();
    expect(session.getSnapshot().error).toBe("Disconnected");
    expect(session.getSnapshot().body).toBe("Mine");
    await session.save();
    expect(write.mock.calls[1]?.[0].baseRevision).toBe(document().revision);
    expect(isNoteDirty(session.getSnapshot())).toBe(false);
  });
});
describe("notes live index and compare", () => {
  it("applies snapshot, move, update and delete without holding bodies", () => {
    const { body: _body, ...summary } = document();
    const first = reduceNotes(emptyNotes, {
      type: "snapshot",
      notes: [summary],
      folders: ["project"],
      truncated: false,
    });
    const moved = reduceNotes(reduceNotes(first, { type: "removed", path: summary.path }), {
      type: "upserted",
      note: { ...summary, path: "other/moved.md", folder: "other" },
    });
    expect(moved.folders).toEqual(["other"]);
    expect(moved.notes).toHaveLength(1);
    expect(moved.notes[0]).not.toHaveProperty("body");
    expect(reduceNotes(moved, { type: "removed", path: "other/moved.md" }).notes).toEqual([]);
  });
  it("does not mark a path missing from a truncated list as deleted", () => {
    const { body: _body, ...summary } = document();
    const loaded = reduceNoteIndex(emptyNoteIndex, {
      type: "snapshot",
      notes: [summary],
      folders: ["project"],
      truncated: true,
    });
    const truncated = reduceNoteIndex(loaded, {
      type: "snapshot",
      notes: [],
      folders: [],
      truncated: true,
    });
    expect(truncated.removedPaths.has(summary.path)).toBe(false);
    const deleted = reduceNoteIndex(truncated, { type: "removed", path: summary.path });
    expect(deleted.removedPaths.has(summary.path)).toBe(true);
    expect(
      reduceNoteIndex(deleted, { type: "upserted", note: summary }).removedPaths.has(summary.path),
    ).toBe(false);
  });
  it("a reconnect snapshot replaces the stale list and retains truncation", () => {
    const state = reduceNotes(emptyNotes, { type: "upserted", note: document() });
    expect(
      reduceNotes(state, { type: "snapshot", notes: [], folders: [], truncated: true }),
    ).toEqual({ notes: [], folders: [], truncated: true });
  });
  it("shows changed lines with current disk removed and draft added", () => {
    expect(compareNoteLines("same\ndisk\nlast", "same\nmine\nlast")).toEqual([
      { type: "same", text: "same" },
      { type: "removed", text: "disk" },
      { type: "added", text: "mine" },
      { type: "same", text: "last" },
    ]);
  });
  it("preserves context between separate paragraph and checkbox edits", () => {
    expect(
      compareNoteLines(
        "Disk paragraph\n\n- [ ] Offline phone draft reaches the hub\n- [ ] Review\nTail",
        "Draft paragraph\n\n- [ ] Offline phone draft reaches the hub\n- [x] Review\nTail",
      ),
    ).toEqual([
      { type: "removed", text: "Disk paragraph" },
      { type: "added", text: "Draft paragraph" },
      { type: "same", text: "" },
      { type: "same", text: "- [ ] Offline phone draft reaches the hub" },
      { type: "removed", text: "- [ ] Review" },
      { type: "added", text: "- [x] Review" },
      { type: "same", text: "Tail" },
    ]);
  });
  it("aligns insertions and deletions around repeated context lines", () => {
    expect(
      compareNoteLines("start\nrepeat\nold\nrepeat\nend", "start\nnew\nrepeat\nrepeat\nend"),
    ).toEqual([
      { type: "same", text: "start" },
      { type: "added", text: "new" },
      { type: "same", text: "repeat" },
      { type: "removed", text: "old" },
      { type: "same", text: "repeat" },
      { type: "same", text: "end" },
    ]);
  });
  it("preserves empty lines, trailing newlines and unchanged notes", () => {
    expect(compareNoteLines("", "")).toEqual([{ type: "same", text: "" }]);
    expect(compareNoteLines("a\n\n", "a\n\n")).toEqual([
      { type: "same", text: "a" },
      { type: "same", text: "" },
      { type: "same", text: "" },
    ]);
    expect(compareNoteLines("a", "a\n")).toEqual([
      { type: "same", text: "a" },
      { type: "added", text: "" },
    ]);
    expect(compareNoteLines("a\n", "a")).toEqual([
      { type: "same", text: "a" },
      { type: "removed", text: "" },
    ]);
  });
  it("uses a bounded whole-block fallback when either side exceeds 2000 lines", () => {
    const large = ["disk", ...Array<string>(1999).fill("context"), "last"].join("\n");
    const small = "draft\ncontext\nchanged\nlast";
    for (const [left, right] of [
      [large, small],
      [small, large],
    ] as const) {
      const diff = compareNoteLines(left, right);
      expect(diff.filter((line) => line.type === "same")).toEqual([{ type: "same", text: "last" }]);
      expect(
        diff
          .filter((line) => line.type !== "added")
          .map((line) => line.text)
          .join("\n"),
      ).toBe(left);
      expect(
        diff
          .filter((line) => line.type !== "removed")
          .map((line) => line.text)
          .join("\n"),
      ).toBe(right);
    }
  });
  it.each([
    { lines: 2000, width: 1, budget: "cells" },
    { lines: 60, width: 10000, budget: "string comparisons" },
  ])("falls back within the line limit when $budget exceed the work budget", ({ lines, width }) => {
    const context = Array<string>(lines - 2).fill("x".repeat(width));
    const left = ["disk", ...context, "old"];
    const right = ["draft", ...context, "new"];
    const diff = compareNoteLines(left.join("\n"), right.join("\n"));
    expect(diff.filter((line) => line.type === "same")).toHaveLength(0);
    expect(diff.slice(0, left.length).every((line) => line.type === "removed")).toBe(true);
    expect(diff.slice(left.length).every((line) => line.type === "added")).toBe(true);
    expect(diff.filter((line) => line.type !== "added").map((line) => line.text)).toEqual(left);
    expect(diff.filter((line) => line.type !== "removed").map((line) => line.text)).toEqual(right);
  });
  it("recognizes a launch whose response was lost without treating normal failures as ambiguous", () => {
    expect(isAmbiguousLaunch({ _tag: "NoteError", reason: "launch_ambiguous" })).toBe(true);
    expect(isAmbiguousLaunch({ reason: "launch_failed" })).toBe(false);
  });
});
