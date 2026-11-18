import { describe, expect, it } from "vite-plus/test";
import {
  ApprovalRequestId,
  ThreadId,
  EnvironmentId,
  type UserInputAttachmentAnswerPayload,
} from "@goat/contracts";
import {
  getQuestionAnswerAttribution,
  getQuestionAnswerPreview,
  getQuestionAnswerText,
} from "./userInput.ts";

function answer(
  overrides: Partial<UserInputAttachmentAnswerPayload> = {},
): UserInputAttachmentAnswerPayload {
  return {
    requestId: ApprovalRequestId.make("request-1"),
    questionTextById: { scope: "Which repository?" },
    answers: { scope: "Use the private repository" },
    attachmentsByQuestionId: {},
    ...overrides,
  };
}

describe("getQuestionAnswerAttribution", () => {
  it("shows local and foreign agent identity and unchanged reason", () => {
    const respondedBy = {
      type: "agent" as const,
      threadId: ThreadId.make("caller"),
      environmentId: null,
      title: "Coordinator",
      reason: "Matches the brief\nKeep the option label",
    };
    const value = answer({ respondedBy });
    expect(getQuestionAnswerAttribution(value)).toBe(
      'Answered by orchestrator "Coordinator": Matches the brief\nKeep the option label',
    );
    expect(
      getQuestionAnswerAttribution(answer({ respondedBy: { ...respondedBy, title: null } })),
    ).toBe('Answered by orchestrator "caller": Matches the brief\nKeep the option label');
    expect(
      getQuestionAnswerAttribution(
        answer({ respondedBy: { ...respondedBy, environmentId: EnvironmentId.make("foreign") } }),
      ),
    ).toBe(
      'Answered by orchestrator "Coordinator" on another machine: Matches the brief\nKeep the option label',
    );
    expect(value.answers).toEqual({ scope: "Use the private repository" });
  });
  it("shows the user's relayed decision with the local or foreign orchestrator identity", () => {
    const respondedBy = {
      type: "agent" as const,
      threadId: ThreadId.make("caller"),
      environmentId: null,
      title: "Coordinator",
      reason: "The user chose the existing API.",
      relayedFromUser: true,
    };
    expect(getQuestionAnswerAttribution(answer({ respondedBy }))).toBe(
      'Answered by the user, relayed by orchestrator "Coordinator": The user chose the existing API.',
    );
    expect(
      getQuestionAnswerAttribution(
        answer({
          respondedBy: {
            ...respondedBy,
            title: null,
            environmentId: EnvironmentId.make("foreign"),
          },
        }),
      ),
    ).toBe(
      'Answered by the user, relayed by orchestrator "caller" on another machine: The user chose the existing API.',
    );
    expect(
      getQuestionAnswerAttribution(
        answer({ respondedBy: { ...respondedBy, relayedFromUser: false } }),
      ),
    ).toBe('Answered by orchestrator "Coordinator": The user chose the existing API.');
  });
  it("shows outside clients and keeps user and legacy history quiet", () => {
    expect(
      getQuestionAnswerAttribution(answer({ respondedBy: { type: "client", reason: "R" } })),
    ).toBe("Answered by an MCP client: R");
    expect(getQuestionAnswerAttribution(answer())).toBeNull();
    expect(getQuestionAnswerAttribution(answer({ respondedBy: { type: "user" } }))).toBeNull();
  });
});

// Shape the web client submits for an answer holding a review-comment chip.
const answerWithReviewComment = [
  "See my note: [Review comment: notes.md L2; ref=review-comment_c1]",
  "",
  '<goat_context version="1">',
  '<context kind="review-comment" id="review-comment_c1">',
  "file: notes.md",
  "range: L2 (2-2)",
  "comment:",
  "  Rename this",
  "diff:",
  "  +line changed",
  "</context>",
  "</goat_context>",
].join("\n");

describe("question answer display", () => {
  it("keeps the provider context envelope out of answer history and preview", () => {
    const history = getQuestionAnswerText(answerWithReviewComment);
    const preview = getQuestionAnswerPreview(
      answer({
        answers: { q1: answerWithReviewComment },
        attachmentsByQuestionId: {},
        questionTextById: { q1: "What should change?" },
      }),
    );

    expect(history).toBe("See my note: [Review comment: notes.md L2]");
    expect(preview).toContain("See my note:");
    expect(preview).not.toContain("<goat_context");

    const typedXml =
      'Use this XML literally: <goat_context version="1"><context kind="review-comment" id="example">keep me</context></goat_context>';
    expect(getQuestionAnswerText(typedXml)).toBe(typedXml);
    const legacy = answerWithReviewComment.replaceAll("goat_context", "t3_context"); // goat-rename: legacy
    expect(getQuestionAnswerText(legacy)).toBe(history);
    const mismatched = answerWithReviewComment.replace('id="review-comment_c1"', 'id="other"');
    expect(getQuestionAnswerText(mismatched)).toBe(mismatched);
  });
});
