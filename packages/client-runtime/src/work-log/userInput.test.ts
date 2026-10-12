import { describe, expect, it } from "vite-plus/test";
import {
  ApprovalRequestId,
  ThreadId,
  EnvironmentId,
  type UserInputAttachmentAnswerPayload,
} from "@goat/contracts";
import { getQuestionTextPreview, getQuestionAnswerAttribution } from "./userInput.ts";

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

describe("getQuestionTextPreview", () => {
  it("joins the question texts", () => {
    expect(
      getQuestionTextPreview(
        answer({ questionTextById: { scope: "Which repository?", name: "What name?" } }),
      ),
    ).toBe("Which repository? · What name?");
  });

  it("normalizes whitespace and skips blank texts", () => {
    expect(
      getQuestionTextPreview(
        answer({ questionTextById: { scope: "Which\nrepository?", x: "  " } }),
      ),
    ).toBe("Which repository?");
  });

  it("returns an empty string without question texts", () => {
    expect(getQuestionTextPreview(answer({ questionTextById: undefined }))).toBe("");
  });
});

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
  it("shows outside clients and keeps user and legacy history quiet", () => {
    expect(
      getQuestionAnswerAttribution(answer({ respondedBy: { type: "client", reason: "R" } })),
    ).toBe("Answered by an MCP client: R");
    expect(getQuestionAnswerAttribution(answer())).toBeNull();
    expect(getQuestionAnswerAttribution(answer({ respondedBy: { type: "user" } }))).toBeNull();
  });
});
