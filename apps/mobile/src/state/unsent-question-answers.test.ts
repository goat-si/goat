import { EnvironmentId, RuntimeRequestId, ThreadId } from "@goat/contracts";
import { userInputDraftKey } from "@goat/client-runtime/state/thread-requests";
import { describe, expect, it } from "vite-plus/test";

import { scopedThreadKey } from "../lib/scopedEntities";
import { questionAttachmentDraftKey } from "./question-attachments";
import { returnUnsentAnswersToThreadDraft } from "./unsent-question-answers";
import type { ComposerDraft } from "./use-composer-drafts";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const threadKey = scopedThreadKey(environmentId, threadId);
const stopped = RuntimeRequestId.make("stopped");
const answered = RuntimeRequestId.make("answered");
const photo = {
  type: "image" as const,
  id: "photo",
  name: "photo.png",
  mimeType: "image/png",
  sizeBytes: 10,
  fileUri: "file:///photo.png",
  previewUri: "file:///photo.png",
};
const notes = {
  type: "file" as const,
  id: "notes",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 10,
  fileUri: "file:///notes.txt",
};

describe("returnUnsentAnswersToThreadDraft", () => {
  it("moves a cancelled answer's text and attachments into the thread draft", () => {
    const drafts: Record<string, ComposerDraft> = {
      [threadKey]: { text: "Earlier draft", attachments: [] },
      [questionAttachmentDraftKey(environmentId, threadId, stopped, "first")]: {
        text: "",
        attachments: [photo],
      },
      [questionAttachmentDraftKey(environmentId, threadId, stopped, "second")]: {
        text: "",
        attachments: [notes],
      },
    };
    const answers = {
      [userInputDraftKey(environmentId, threadId, stopped)]: {
        first: { customAnswer: "Purple" },
        third: { customAnswer: "  " },
      },
    };

    const next = returnUnsentAnswersToThreadDraft({
      drafts,
      answers,
      environmentId,
      threadId,
      unansweredRequestIds: [stopped],
    });

    expect(next[threadKey]?.text.startsWith("Earlier draft\n\nPurple")).toBe(true);
    expect(next[threadKey]?.attachments.map((attachment) => attachment.id)).toEqual([
      "photo",
      "notes",
    ]);
    // The file shows only as a chip on mobile, so the move adds one.
    expect(next[threadKey]?.context?.records.map((record) => record.kind)).toEqual(["file"]);
  });

  it("leaves the thread draft alone for answered requests and empty answers", () => {
    const drafts: Record<string, ComposerDraft> = {
      [threadKey]: { text: "Earlier draft", attachments: [] },
      [questionAttachmentDraftKey(environmentId, threadId, answered, "first")]: {
        text: "",
        attachments: [photo],
      },
    };
    const answers = {
      [userInputDraftKey(environmentId, threadId, answered)]: { first: { customAnswer: "Sent" } },
      [userInputDraftKey(environmentId, threadId, stopped)]: { first: { customAnswer: " " } },
    };

    expect(
      returnUnsentAnswersToThreadDraft({
        drafts,
        answers,
        environmentId,
        threadId,
        unansweredRequestIds: [stopped],
      }),
    ).toBe(drafts);
  });
});
