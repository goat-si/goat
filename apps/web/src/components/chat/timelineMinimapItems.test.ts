import { EnvironmentId, MessageId, ThreadId } from "@goat/contracts";
import { serializeAssistantCitation } from "@goat/shared/assistantCitations";
import {
  formatComposerContextReference,
  toComposerContextId,
} from "@goat/shared/composerContextReferences";
import { expect, it } from "vite-plus/test";

import { resolveTimelineMinimapPreview } from "./timelineMinimapItems";

it.each(["goat", "t3"])(
  "previews %s quotes, context chips and links as readable text",
  (scheme) => {
    const quote = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make("assistant-1"),
      text: "The cache misses on a cold start.",
      start: 0,
      end: 33,
      prefix: "",
      suffix: "",
      comment: "Can you verify?",
    });
    const response = formatComposerContextReference({
      kind: "response",
      contextId: toComposerContextId("response"),
      label: "Earlier response",
    });
    const file = formatComposerContextReference({
      kind: "file",
      contextId: toComposerContextId("readme"),
      label: "README.md",
    });
    const preview = resolveTimelineMinimapPreview({
      id: "turn-1",
      rowIndex: 0,
      userText: `${quote}\nCompare ${response} with ${file} and [math.ts](src/math.ts).`.replaceAll(
        "goat-",
        `${scheme}-`,
      ),
      assistantText: "Found **two** references.",
    });
    expect(preview?.userText).toBe(
      "The cache misses on a cold start. Comment: Can you verify? Compare Earlier response with README.md and math.ts.",
    );
    expect(preview?.assistantText).toBe("Found two references.");
  },
);

it("caps the streamed assistant preview and leaves empty user previews empty", () => {
  const assistantText = "x".repeat(1_500);
  const preview = resolveTimelineMinimapPreview({
    id: "turn-1",
    rowIndex: 0,
    userText: " \n ",
    assistantText: `${assistantText}\n\nAnother section`,
  });
  expect(preview?.userText).toBeNull();
  expect(preview?.assistantText).toBe(assistantText);
});
