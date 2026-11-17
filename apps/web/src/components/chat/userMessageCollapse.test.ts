import { EnvironmentId, MessageId, ThreadId } from "@goat/contracts";
import { serializeAssistantCitation } from "@goat/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import { shouldCollapseUserMessage } from "./userMessageCollapse";

describe("shouldCollapseUserMessage", () => {
  it("measures a quote chip by its label, not its encoded link", () => {
    const quote = "A long assistant paragraph that the user quoted. ".repeat(40);
    const citation = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("source"),
      text: quote,
      comment: "Why does this matter?",
      start: 0,
      end: quote.length,
      prefix: "",
      suffix: "",
    });

    expect(shouldCollapseUserMessage(`${citation} Can you expand on this?`)).toBe(false);
    expect(shouldCollapseUserMessage(`${citation} ${"More text. ".repeat(60)}`)).toBe(true);
  });
});
