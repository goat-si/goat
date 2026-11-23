import { describe, expect, it } from "vite-plus/test";
import { formatWorkspaceRelativePath } from "./filePathDisplay";

describe("formatWorkspaceRelativePath", () => {
  it("keeps home paths as written instead of labelling them as workspace paths", () => {
    expect(formatWorkspaceRelativePath("~/.claude/CLAUDE.md", "/workspace/goat")).toBe(
      "~/.claude/CLAUDE.md",
    );
    expect(formatWorkspaceRelativePath("~\\.claude\\CLAUDE.md:3", "C:\\dev\\goat")).toBe(
      "~/.claude/CLAUDE.md:3",
    );
  });
});
