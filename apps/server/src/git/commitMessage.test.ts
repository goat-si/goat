import { describe, expect, it } from "vite-plus/test";
import { sanitizeCommitMessage } from "./commitMessage.ts";

describe("generated commit subjects", () => {
  it("normalizes only conventional descriptions and keeps names and acronyms", () => {
    const sanitize = (subject: string, conventional: boolean) =>
      sanitizeCommitMessage(
        { subject, body: "" },
        conventional ? "conventional_commits" : undefined,
      ).subject;
    expect(sanitize("feat(web)!: Add layout", true)).toBe("feat(web)!: add layout");
    expect(sanitize("ci: GitHub checks", true)).toBe("ci: GitHub checks");
    expect(sanitize("ci: E2E checks", true)).toBe("ci: E2E checks");
    expect(sanitize("feat: Add layout", false)).toBe("feat: Add layout");
  });
});
