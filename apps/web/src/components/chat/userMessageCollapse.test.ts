import { EnvironmentId, MessageId, ThreadId } from "@goat/contracts";
import { serializeAssistantCitation } from "@goat/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import { shouldCollapseUserMessage } from "./userMessageCollapse";

describe("shouldCollapseUserMessage", () => {
  it("measures a quote by its card, not its encoded link", () => {
    const quote = "A long assistant paragraph that the user quoted. ".repeat(40);
    const source = {
      version: 1 as const,
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("source"),
      text: quote,
      start: 0,
      end: quote.length,
      prefix: "",
      suffix: "",
    };
    const citation = serializeAssistantCitation({ ...source, comment: "Why does this matter?" });
    const bare = serializeAssistantCitation(source);

    expect(shouldCollapseUserMessage(`${citation} Can you expand on this?`)).toBe(false);
    expect(shouldCollapseUserMessage(`${citation} ${"More text. ".repeat(60)}`)).toBe(true);
    expect(shouldCollapseUserMessage(bare.repeat(2))).toBe(false);
    expect(shouldCollapseUserMessage(bare.repeat(10))).toBe(true);
  });
});
