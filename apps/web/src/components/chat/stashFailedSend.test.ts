import { EnvironmentId } from "@goat/contracts";
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
