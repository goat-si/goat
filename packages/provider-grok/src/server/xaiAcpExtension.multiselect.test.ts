import { describe, expect, it } from "@effect/vitest";

import { makeXAiAskUserQuestionResponse } from "./xaiAcpExtension.ts";

describe("XAiAcpExtension multi-select answers", () => {
  it("answers a multi-select question with nothing checked as an empty list", () => {
    const response = makeXAiAskUserQuestionResponse(
      {
        sessionId: "session-1",
        toolCallId: "tool-call-1",
        mode: "default",
        questions: [
          {
            question: "Which files should Grok touch?",
            multiSelect: true,
            options: [
              { label: "Tests", description: "Update tests" },
              { label: "Docs", description: "Update docs" },
            ],
          },
        ],
      },
      { "Which files should Grok touch?": [] },
    );

    expect(response).toEqual({
      outcome: "accepted",
      answers: { "Which files should Grok touch?": [] },
    });
  });
});
