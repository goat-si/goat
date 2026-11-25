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

it("completes a quote begun in the raw prefix without expanding a later Reply chip", () => {
  const quote = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("t".repeat(1_600)),
    messageId: MessageId.make("message"),
    text: "A short question.",
    start: 0,
    end: 17,
    prefix: "",
    suffix: "",
  });
  const later = formatComposerContextReference({
    kind: "response",
    contextId: toComposerContextId("later"),
    label: "Outside the preview",
  });
  const item = { id: "turn-1", rowIndex: 0, assistantText: null };
  expect(resolveTimelineMinimapPreview({ ...item, userText: `${quote}\n${later}` })?.userText).toBe(
    "A short question.",
  );
});

it("keeps the complete label of a context chip whose opening bracket is in the prefix", () => {
  const prefix = "x".repeat(1_498);
  const reply = "[Earlier response](goat-context://v1/response/earlier)";
  expect(
    resolveTimelineMinimapPreview({
      id: "turn-1",
      rowIndex: 0,
      userText: `${prefix} ${reply} outside`,
      assistantText: null,
    })?.userText,
  ).toBe(`${prefix} Earlier response`);
});

it.each([
  { text: "x".repeat(8_000), comment: "y".repeat(8_000), prefix: "" },
  { text: "A short question.", comment: "y".repeat(8_000), prefix: "Please check " },
])("caps the combined decoded quote and comment before flattening", ({ text, comment, prefix }) => {
  const quote = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    text,
    start: 0,
    end: text.length,
    prefix: "",
    suffix: "",
    comment,
  });
  const preview = resolveTimelineMinimapPreview({
    id: "turn",
    rowIndex: 0,
    userText: prefix + quote,
    assistantText: null,
  });
  expect(preview?.userText).toHaveLength(1_500);
  expect(preview?.userText).toBe(`${prefix}${text} Comment: ${comment}`.slice(0, 1_500));
});

it.each([
  {
    field: "quote",
    text: `${"x".repeat(1_499)}😀`,
    comment: undefined,
    expected: "x".repeat(1_499),
  },
  {
    field: "comment",
    text: "x",
    comment: `${"y".repeat(1_488)}😀`,
    expected: `x Comment: ${"y".repeat(1_488)}`,
  },
])("keeps the citation $field cutoff out of a surrogate pair", ({ text, comment, expected }) => {
  const quote = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    text,
    start: 0,
    end: text.length,
    prefix: "",
    suffix: "",
    ...(comment === undefined ? {} : { comment }),
  });
  const preview = resolveTimelineMinimapPreview({
    id: "turn",
    rowIndex: 0,
    userText: quote,
    assistantText: null,
  });
  expect(preview?.userText).toBe(expected);
});

it("does not split a surrogate pair at the preview slice boundary", () => {
  const linkStart = "[Build log](https://example.com/builds/1042/log?sig=";
  const linkEnd = ") ";
  const pad = "a".repeat(1_499 - linkStart.length - linkEnd.length);
  const preview = resolveTimelineMinimapPreview({
    id: "turn-1",
    rowIndex: 0,
    userText: `${linkStart}${pad}${linkEnd}🎉 the release build passed`,
    assistantText: null,
  });
  expect(preview?.userText).toBe("Build log");
});
