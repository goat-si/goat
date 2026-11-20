import { ComposerContextId, EnvironmentId, RuntimeRequestId, ThreadId } from "@goat/contracts";
import { userInputDraftKey } from "@goat/client-runtime/state/thread-requests";
import { formatComposerContextReference } from "@goat/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { scopedThreadKey } from "../lib/scopedEntities";
import { questionAttachmentDraftKey } from "./question-attachments";
import { returnUnsentAnswersToThreadDraft } from "./user-input-drafts";
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

  // The same case appendAnswerToDraft and web's questionAttachments test run.
  it("keeps every returned answer, even one equal to the draft's last paragraph", () => {
    const drafts: Record<string, ComposerDraft> = {
      [threadKey]: { text: "Draft\n\nYes\n", attachments: [] },
    };
    const answers = {
      [userInputDraftKey(environmentId, threadId, stopped)]: {
        first: { customAnswer: "Yes" },
        second: { customAnswer: "Yes" },
      },
    };

    const next = returnUnsentAnswersToThreadDraft({
      drafts,
      answers,
      environmentId,
      threadId,
      unansweredRequestIds: [stopped],
    });

    expect(next[threadKey]?.text).toBe("Draft\n\nYes\n\nYes\n\nYes");
  });

  // As web's threadContextsReferencedByAnswer: a question draft keeps deleted chips for undo,
  // so only the chips the answer itself references come back (coordinator D1 (a)).
  it("returns only the context chips the answer references", () => {
    const terminal = (id: string) => ({
      version: 1 as const,
      kind: "terminal" as const,
      contextId: ComposerContextId.make(id),
      label: id,
      terminalId: "main",
      terminalLabel: "Terminal",
      lineStart: 1,
      lineEnd: 2,
      text: "output",
    });
    const kept = terminal("kept");
    const left = terminal("left");
    const drafts: Record<string, ComposerDraft> = {
      // The thread draft names "left" in its own text, but only the question holds the chip.
      [threadKey]: { text: `See ${formatComposerContextReference(left)}`, attachments: [] },
      [questionAttachmentDraftKey(environmentId, threadId, stopped, "first")]: {
        text: "",
        attachments: [],
        context: { version: 1, records: [kept, left] },
      },
    };
    const answers = {
      [userInputDraftKey(environmentId, threadId, stopped)]: {
        first: { customAnswer: `Use ${formatComposerContextReference(kept)}` },
      },
    };

    const next = returnUnsentAnswersToThreadDraft({
      drafts,
      answers,
      environmentId,
      threadId,
      unansweredRequestIds: [stopped],
    });

    expect(next[threadKey]?.context?.records.map((record) => record.contextId)).toEqual(["kept"]);
  });
});
