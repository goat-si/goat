import { describe, expect, it } from "vite-plus/test";

import {
  collectInlineContextIds,
  formatInlineContextReference,
  removeInlineContextReference,
  stripInlineContextReferences,
} from "./composerContextReferences";

const review = { kind: "review-comment", contextId: "rc-1", label: "a.ts L4" };
const reviewLink = "[a.ts L4](goat-context://v1/review-comment/rc-1)";
const previewLink = "[Checkout](goat-context://v1/preview-annotation/pa-1)";

describe("composerContextReferences", () => {
  it("formats, collects and strips references of any kind", () => {
    expect(formatInlineContextReference(review)).toBe(reviewLink);
    const prompt = `x ${reviewLink} y ${previewLink} ${reviewLink}`.replaceAll(
      "goat-context://",
      "t3-context://",
    );
    expect(collectInlineContextIds(prompt)).toEqual(["rc-1", "pa-1"]);
    expect(stripInlineContextReferences(prompt)).toBe("x  y  ");
  });

  it("removes every occurrence of an id and reports the earliest cursor", () => {
    const prompt = `${reviewLink} mid ${reviewLink} end`.replaceAll(
      "goat-context://",
      "t3-context://",
    );
    expect(removeInlineContextReference(prompt, "rc-1")).toEqual({
      prompt: "mid end",
      cursor: 0,
    });
    expect(removeInlineContextReference("plain", "rc-1")).toEqual({ prompt: "plain", cursor: 5 });
  });
});
