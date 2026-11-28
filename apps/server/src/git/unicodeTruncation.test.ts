import { describe, expect, it } from "vitest";
import { sanitizeCommitMessage, sanitizeProgressText } from "./commitMessage.ts";
import { summarizeGitActionResult } from "./gitActionSummary.ts";

describe("Git action text truncation", () => {
  it("does not split emoji in commit subjects or progress", () => {
    expect(sanitizeCommitMessage({ subject: "a".repeat(71) + "😀", body: "" }).subject).toBe(
      "a".repeat(71),
    );
    expect(sanitizeProgressText("a".repeat(499) + "😀")).toBe("a".repeat(499));
  });
  it("does not split emoji in toast descriptions", () => {
    const result = {
      commit: { status: "created", subject: "a".repeat(68) + "😀more", commitSha: "12345678" },
      push: { status: "skipped" },
      pr: { status: "skipped" },
    } as const;
    expect(summarizeGitActionResult(result, { shortLabel: "PR" } as never).description).toBe(
      "a".repeat(68) + "...",
    );
  });
});
