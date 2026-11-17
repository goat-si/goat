import {
  type ComposerContextId,
  EnvironmentId,
  MessageId,
  type ResponseContextRecord,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { snapshotComposerSend } from "./ChatView.logic";
import { responseContextReference } from "../lib/composerContextRecords";
import { formatInlineContextReference } from "../lib/composerContextReferences";

const reply: ResponseContextRecord = {
  version: 1,
  kind: "response",
  contextId: "response_m1" as ComposerContextId,
  label: "The fix is in",
  citation: {
    version: 1,
    environmentId: EnvironmentId.make("environment-local"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("m1"),
    text: "The fix is in",
    start: 0,
    end: 13,
    prefix: "",
    suffix: "",
  },
  itemId: TurnItemId.make("item-1"),
};

const contents = (prompt: string, replyTo: ResponseContextRecord | null) => ({
  prompt,
  images: [],
  files: [],
  terminalContexts: [],
  sendableTerminalContexts: [],
  previewAnnotations: [],
  reviewComments: [],
  threadContexts: [],
  replyTo,
});

describe("a send that replies to a response", () => {
  it("sends the reply's reference and puts the reply back above the text when the send fails", () => {
    const reference = formatInlineContextReference(responseContextReference(reply));
    const snapshot = snapshotComposerSend(
      contents(`${reference} also check the empty state`, reply),
    );
    expect(snapshot.replyTo).toBe(reply);
    expect(snapshot.messageText).toBe(`${reference} also check the empty state`);
    expect(snapshot.draftText).toBe("also check the empty state");
  });

  it("restores the text as sent when there is no reply", () => {
    const snapshot = snapshotComposerSend(contents("just text", null));
    expect(snapshot.replyTo).toBeNull();
    expect(snapshot.draftText).toBe("just text");
  });
});
