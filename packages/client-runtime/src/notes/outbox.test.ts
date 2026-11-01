import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, NoteDocument } from "@goat/contracts";
import * as Schema from "effect/Schema";
import {
  acknowledgeNote,
  conflictNote,
  enqueueNote,
  markNoteInFlight,
  NoteOutboxRow,
  noteOutboxKey,
  noteWriteInput,
  resolveNote,
  restoreNote,
  type NoteEdit,
} from "./outbox.ts";

const decodeRow = Schema.decodeUnknownSync(NoteOutboxRow);
const revision = "a".repeat(64);
const current = Schema.decodeUnknownSync(NoteDocument)({
  path: "note.md",
  folder: null,
  title: "Note",
  body: "hub",
  status: "doing",
  threads: [],
  updatedBy: "agent",
  revision: "b".repeat(64),
  updatedAt: "2026-10-19T00:00:00.000Z",
  size: 3,
});
const edit: NoteEdit = {
  environmentId: EnvironmentId.make("hub"),
  path: "note.md",
  body: "first",
  status: "idea",
  baseRevision: revision,
  localUpdatedAt: 1,
};
const queued = () => enqueueNote([], edit)[0]!;

describe("notes outbox", () => {
  it("coalesces NFC paths within one environment and preserves the original base revision", () => {
    let rows = enqueueNote([], { ...edit, path: "cafe\u0301.md" });
    rows = enqueueNote(rows, {
      ...edit,
      path: "café.md",
      body: "newer",
      baseRevision: current.revision,
    });
    rows = enqueueNote(rows, {
      ...edit,
      environmentId: EnvironmentId.make("other"),
      path: "café.md",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      path: "café.md",
      body: "newer",
      baseRevision: revision,
      localUpdatedAt: 2,
    });
    expect(noteOutboxKey("hub", "cafe\u0301.md")).toBe(noteOutboxKey("hub", "café.md"));
  });
  it("preserves create-only null revisions and a queued status when only the body changes", () => {
    const rows = enqueueNote(enqueueNote([], { ...edit, baseRevision: null, status: "done" }), {
      ...edit,
      status: undefined,
      body: "latest",
    });
    expect(rows[0]).toMatchObject({ baseRevision: null, status: "done", body: "latest" });
  });
  it("keeps versions monotonic when the clock goes backwards", () => {
    const rows = enqueueNote([queued()], { ...edit, localUpdatedAt: -100 });
    expect(rows[0]!.localUpdatedAt).toBe(2);
  });
  it("captures the sent payload independently from later edits", () => {
    const sent = markNoteInFlight(queued());
    const next = enqueueNote([sent], { ...edit, body: "second", status: "doing" })[0]!;
    expect(noteWriteInput(next)).toEqual({
      path: "note.md",
      body: "first",
      status: "idea",
      baseRevision: revision,
    });
    expect(next.body).toBe("second");
  });
  it("drops a matching acknowledgement", () => {
    expect(acknowledgeNote(markNoteInFlight(queued()), 1, current.revision)).toBeNull();
  });
  it("advances the base revision without dropping newer edits", () => {
    const sent = markNoteInFlight(queued());
    const next = enqueueNote([sent], { ...edit, body: "second" })[0]!;
    expect(acknowledgeNote(next, 1, current.revision)).toMatchObject({
      body: "second",
      baseRevision: current.revision,
      inFlight: null,
      state: "pending",
    });
  });
  it("ignores an acknowledgement for a different send", () => {
    const sent = markNoteInFlight(queued());
    expect(acknowledgeNote(sent, 0, current.revision)).toBe(sent);
    expect(acknowledgeNote(queued(), 1, current.revision)).not.toBeNull();
  });
  it("retains conflict state across further editing and restart", () => {
    const conflict = conflictNote(markNoteInFlight(queued()), current);
    expect(markNoteInFlight(conflict)).toBe(conflict);
    expect(restoreNote(enqueueNote([conflict], { ...edit, body: "third" })[0]!)).toMatchObject({
      state: "conflict",
      current,
      body: "third",
      baseRevision: revision,
      inFlight: null,
    });
  });
  it("resolves mine against the displayed current revision, or discards mine explicitly", () => {
    const conflict = conflictNote(queued(), current);
    expect(resolveNote(conflict, "mine")).toMatchObject({
      state: "pending",
      baseRevision: current.revision,
      body: "first",
      current: null,
    });
    expect(resolveNote(conflict, "theirs")).toBeNull();
    expect(resolveNote(queued(), "theirs")).not.toBeNull();
  });
  it("restores interrupted sends as pending without pretending the hub acknowledged them", () => {
    expect(restoreNote(markNoteInFlight(queued()))).toEqual(queued());
  });
  it("rejects paths outside the notes hierarchy", () => {
    expect(() => enqueueNote([], { ...edit, path: "../note.md" })).toThrow();
    expect(() => enqueueNote([], { ...edit, path: "a/b/note.md" })).toThrow();
  });
});

it("loads a stored conflict whose title predates the wire title cap", () => {
  const stored = {
    environmentId: "hub",
    path: "note.md",
    body: "mine",
    baseRevision: revision,
    localUpdatedAt: 1,
    state: "conflict",
    current: { ...current, title: "t".repeat(300) },
    inFlight: null,
  };
  expect(decodeRow(stored).current?.title).toHaveLength(300);
});

it("loads drafts saved under paths that predate the folder length limit", () => {
  const legacy = {
    environmentId: "hub",
    path: `${"f".repeat(121)}/a.md`,
    body: "mine",
    baseRevision: null,
    localUpdatedAt: 1,
    state: "pending",
    current: null,
    inFlight: null,
  };
  expect(decodeRow(legacy).path).toBe(legacy.path);
});
