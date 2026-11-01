import { describe, expect, it } from "vite-plus/test";
import {
  ApprovalRequestId,
  ThreadId,
  EnvironmentId,
  type UserInputAttachmentAnswerPayload,
} from "@goat/contracts";
import { getQuestionAnswerAttribution } from "./userInput.ts";

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
