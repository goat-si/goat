import { describe, expect, it } from "vite-plus/test";

import {
  buildCollapsedProposedPlanPreviewMarkdown,
  resolvePlanFollowUpSubmission,
} from "./proposedPlan";

describe("resolvePlanFollowUpSubmission", () => {
  it.each(["", "Consider this "])(
    "keeps context-bearing feedback in plan mode with prose %j",
    (prose) => {
      const draftText = `${prose}[PR #42](t3-context://v1/review-comment/pr-42)`;
      expect(resolvePlanFollowUpSubmission({ draftText, planMarkdown: "# Plan" })).toEqual({
        text: draftText,
        interactionMode: "plan",
      });
    },
  );
  it("switches to default mode when implementing the ready plan without extra text", () => {
    expect(
      resolvePlanFollowUpSubmission({
        draftText: "   ",
        planMarkdown: "## Ship it\n\n- step 1\n",
      }),
    ).toEqual({
      text: "PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1",
      interactionMode: "default",
    });
  });
});

describe("buildCollapsedProposedPlanPreviewMarkdown", () => {
  it("closes a code block the preview cuts through, so the ellipsis stays outside it", () => {
    const plan = [
      "- Step",
      "  ```ts",
      "  const a = 1;",
      "  const b = 2;",
      "  ```",
      "",
      "Done.",
    ].join("\n");
    expect(buildCollapsedProposedPlanPreviewMarkdown(plan, { maxLines: 3 })).toBe(
      ["- Step", "  ```ts", "  const a = 1;", "  ```", "", "..."].join("\n"),
    );
  });

  it("adds no fence when every code block ends inside the preview, inline code included", () => {
    const plan = ["~~~~", "```", "~~~~", "", "```npm i```", "Next", "More"].join("\n");
    expect(buildCollapsedProposedPlanPreviewMarkdown(plan, { maxLines: 5 })).toBe(
      ["~~~~", "```", "~~~~", "", "```npm i```", "Next", "", "..."].join("\n"),
    );
  });
});
