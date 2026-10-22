import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { NOTE_FOLDER_MAX_LENGTH, NoteFolder, NotePath } from "./notes.ts";

const isPath = Schema.is(NotePath);
const isFolder = Schema.is(NoteFolder);

describe("NotePath", () => {
  it("accepts a root note or a note in one folder", () => {
    expect(isPath("ideas.md")).toBe(true);
    expect(isPath("goat hub/plan v2.md")).toBe(true);
  });

  it("refuses paths that leave the notes folder or nest deeper than one folder", () => {
    for (const path of [
      "../escape.md",
      "/abs.md",
      "a/b/c.md",
      "a//b.md",
      "./x.md",
      ".hidden.md",
      "folder/.git.md",
      ".git/config.md",
      "a\\b.md",
      "notes.txt",
      ".md",
      " padded.md",
      "tab\tname.md",
      "x".repeat(300) + ".md",
    ]) {
      expect(isPath(path), path).toBe(false);
    }
  });

  it("refuses non-NFC spellings so one file has one key", () => {
    const decomposed = "cafe\u0301.md";
    expect(isPath(decomposed)).toBe(false);
    expect(isPath(decomposed.normalize("NFC"))).toBe(true);
  });

  it("bounds the folder segment exactly like NoteFolder", () => {
    const longest = "f".repeat(NOTE_FOLDER_MAX_LENGTH);
    expect(isFolder(longest)).toBe(true);
    expect(isPath(`${longest}/a.md`)).toBe(true);
    expect(isFolder(`${longest}f`)).toBe(false);
    expect(isPath(`${longest}f/a.md`)).toBe(false);
  });
});

describe("NoteFolder", () => {
  it("is a single visible segment", () => {
    expect(isFolder("project")).toBe(true);
    expect(isFolder("a/b")).toBe(false);
    expect(isFolder(".git")).toBe(false);
    expect(isFolder("")).toBe(false);
  });
});
