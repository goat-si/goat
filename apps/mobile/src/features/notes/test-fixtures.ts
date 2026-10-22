import { EnvironmentId, NoteDocument } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { enqueueNote } from "@goat/client-runtime/notes";

export const hub = EnvironmentId.make("hub");
const decodeDocument = Schema.decodeSync(NoteDocument);
export const document = (body = "hub", revision = "b".repeat(64)) =>
  decodeDocument({
    path: "note.md",
    folder: null,
    title: "Note",
    body,
    status: "idea",
    threads: [],
    updatedBy: "user",
    revision,
    updatedAt: "2026-10-19T00:00:00.000Z",
    size: body.length,
  });
export const edit = {
  environmentId: hub,
  path: "note.md",
  body: "mine",
  status: "idea" as const,
  baseRevision: "a".repeat(64),
  localUpdatedAt: 1,
};
export const row = () => enqueueNote([], edit)[0]!;
