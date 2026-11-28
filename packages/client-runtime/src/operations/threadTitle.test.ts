import { describe, expect, it } from "@effect/vitest";
import { threadTitleTextFromPrompt } from "./threadTitle.ts";

describe("threadTitleTextFromPrompt", () => {
  it("composes NFD macOS paths mentioned in the prompt", () => {
    expect(threadTitleTextFromPrompt("Read @\u1109\u1175\u110b\u1161\u11ab/a.txt")).toBe(
      "Read @\uc2dc\uc548/a.txt",
    );
  });
});
