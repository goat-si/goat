import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  type ComposerContextId,
  EnvironmentId,
  MessageId,
  type ResponseContextRecord,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ComposerSendSnapshot } from "../ChatView.logic";

const toast = vi.hoisted(() => vi.fn());
vi.mock("../ui/toast", () => ({
  toastManager: { add: toast },
  stackedThreadToast: (options: unknown) => options,
}));
vi.mock("../../lib/imageCompression", () => ({
  compressImageForStash: async () => ({
    ok: true,
    image: { mimeType: "image/webp", sizeBytes: 3, dataUrl: "data:image/webp;base64,AAA" },
  }),
}));

import { usePromptStashStore } from "../../promptStashStore";
import { keepFailedSendInStash } from "./stashFailedSend";
import { useComposerDraftStore } from "../../composerDraftStore";
import { restoreStashedReply } from "./composerReply";

const environmentId = EnvironmentId.make("environment-1");
const image = {
  type: "image" as const,
  id: "image-1",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 5,
  previewUrl: "blob:screen",
  file: new File(["image"], "screen.png", { type: "image/png" }),
};
const file = {
  type: "file" as const,
  id: "file-1",
  name: "log.txt",
  mimeType: "text/plain",
  sizeBytes: 3,
  file: new File(["log"], "log.txt", { type: "text/plain" }),
};

function snapshot(messageText: string): ComposerSendSnapshot {
  return {
    images: [image],
    files: [file],
    attachments: [image, file],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    previewTabs: [],
    messageText,
    replyTo: null,
    draftText: messageText,
  };
}

const realStash = usePromptStashStore.getState();
beforeEach(() => {
  toast.mockClear();
  usePromptStashStore.setState({ ...realStash, entries: [] });
});

describe("keepFailedSendInStash", () => {
  // regression: an attachment-only send whose stash write storage rejected vanished without a word
  it("names the lost attachments when storage rejects the stash of a send without text", async () => {
    usePromptStashStore.setState({
      stashEntry: () => ({ evicted: null, written: false, durable: false }),
    });

    await keepFailedSendInStash({ snapshot: snapshot(""), environmentId, interrupted: false });

    expect(toast).toHaveBeenCalledOnce();
    const shown = toast.mock.calls[0]?.[0] as { description: string; actionProps?: unknown };
    expect(shown.description).toContain("screen.png");
    expect(shown.description).toContain("log.txt");
    expect(shown.actionProps).toBeUndefined();
  });

  it("names the lost attachments beside Copy when storage rejects the stash of a send with text", async () => {
    usePromptStashStore.setState({
      stashEntry: () => ({ evicted: null, written: false, durable: false }),
    });

    await keepFailedSendInStash({ snapshot: snapshot("See"), environmentId, interrupted: false });

    expect(toast).toHaveBeenCalledOnce();
    const shown = toast.mock.calls[0]?.[0] as {
      description: string;
      actionProps?: { children: string };
    };
    expect(shown.description).toContain("screen.png, log.txt could not be kept");
    expect(shown.actionProps?.children).toBe("Copy message");
  });

  it("warns when the entry was restored before its images finished saving", async () => {
    usePromptStashStore.setState({
      finalizeEntryImages: () => ({ attached: false, durable: true }),
    });

    await keepFailedSendInStash({ snapshot: snapshot("See"), environmentId, interrupted: false });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Stashed images did not attach" }),
    );
  });
});

describe("a failed send that replied to a response", () => {
  it("keeps the reply in the stash and puts it back above the composer on restore", async () => {
    const threadRef = scopeThreadRef(environmentId, ThreadId.make("reply-thread"));
    const reply: ResponseContextRecord = {
      version: 1,
      kind: "response",
      contextId: "response_m1" as ComposerContextId,
      label: "The fix is in",
      citation: {
        version: 1,
        environmentId,
        threadId: threadRef.threadId,
        messageId: MessageId.make("m1"),
        text: "The fix is in",
        start: 0,
        end: 13,
        prefix: "",
        suffix: "",
      },
      itemId: TurnItemId.make("item-1"),
    };
    const sent = "[The fix is in](goat-context://v1/response/response_m1) check the empty state";
    await keepFailedSendInStash({
      snapshot: {
        ...snapshot(sent),
        images: [],
        files: [],
        attachments: [],
        replyTo: reply,
        draftText: "check the empty state",
      },
      environmentId,
      interrupted: false,
    });

    const [entry] = usePromptStashStore.getState().entries;
    expect(entry?.prompt).toBe("check the empty state");
    expect(entry?.records).toContainEqual(reply);

    restoreStashedReply(entry?.records ?? [], threadRef);
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.replyTo).toEqual(reply);
  });
});
