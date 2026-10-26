import { describe, expect, it } from "@effect/vitest";

import {
  identityToken,
  isRemovableTempName,
  isRotatedLogName,
  isStrictlyInside,
  overlaps,
  pathRules,
} from "./storagePaths.ts";

const posix = pathRules("linux", "/");
const mac = pathRules("darwin", "/");
const windows = pathRules("win32", "\\");

describe("storage path containment", () => {
  it("counts only paths strictly below the root as inside it", () => {
    expect(isStrictlyInside("/goat/worktrees", "/goat/worktrees/repo/a", posix)).toBe(true);
    expect(isStrictlyInside("/goat/worktrees/", "/goat/worktrees/repo", posix)).toBe(true);
    // The root itself and a sibling that shares its prefix are outside.
    expect(isStrictlyInside("/goat/worktrees", "/goat/worktrees", posix)).toBe(false);
    expect(isStrictlyInside("/goat/worktrees", "/goat/worktrees-old/repo", posix)).toBe(false);
    expect(isStrictlyInside("/goat/worktrees", "/goat", posix)).toBe(false);
  });

  it("folds case only where the volume does", () => {
    expect(isStrictlyInside("/Users/Me/.goat", "/users/me/.goat/worktrees", mac)).toBe(true);
    expect(isStrictlyInside("/home/Me/.goat", "/home/me/.goat/worktrees", posix)).toBe(false);
    expect(isStrictlyInside("C:\\Goat\\worktrees", "c:\\goat\\WORKTREES\\a", windows)).toBe(true);
  });

  it("treats a folder inside, around or equal to a project folder as overlapping it", () => {
    expect(overlaps("/repo", "/repo", posix)).toBe(true);
    expect(overlaps("/repo", "/repo/packages/a", posix)).toBe(true);
    expect(overlaps("/repo/packages/a", "/repo", posix)).toBe(true);
    expect(overlaps("/repo", "/repo-copy", posix)).toBe(false);
  });
});

describe("storage cleanup names", () => {
  it("offers only temp folders of one-shot operations, never sockets, jobs or the updater", () => {
    expect(isRemovableTempName("goat-claude-title-abc123")).toBe(true);
    expect(isRemovableTempName("goat-codex-reception-home-x")).toBe(true);
    expect(isRemovableTempName("goat-token-abc")).toBe(false);
    expect(isRemovableTempName("goat-job-abc")).toBe(false);
    expect(isRemovableTempName("goat-runtime-update-abc")).toBe(false);
    expect(isRemovableTempName("goat-claude-title-")).toBe(false);
    expect(isRemovableTempName("unrelated")).toBe(false);
  });

  it("recognises rotated log copies but not the live files", () => {
    expect(isRotatedLogName("server.trace.ndjson.3")).toBe(true);
    expect(isRotatedLogName("provider.log.1")).toBe(true);
    expect(isRotatedLogName("server.trace.ndjson")).toBe(false);
    expect(isRotatedLogName("notes.txt.1")).toBe(false);
  });

  it("changes the identity token with any part, so a confirmation covers one exact state", () => {
    const token = identityToken(["worktree", "/w/a", "abc", "main"]);
    expect(identityToken(["worktree", "/w/a", "abc", "main"])).toBe(token);
    expect(identityToken(["worktree", "/w/a", "abd", "main"])).not.toBe(token);
    expect(identityToken(["worktree", "/w/a", 1n, 2n])).not.toBe(
      identityToken(["worktree", "/w/a", 1n, 3n]),
    );
  });
});
