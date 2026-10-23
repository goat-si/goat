import { noteSurfaceEntries } from "../notes.ts";
import { entry } from "../entry.ts";

export const noteEntries = {
  "note.list": entry(noteSurfaceEntries.list),
  "note.read": entry(noteSurfaceEntries.read),
  "note.write": entry(noteSurfaceEntries.write),
  "note.update": entry(noteSurfaceEntries.update),
  "note.move": entry(noteSurfaceEntries.move),
} as const;
