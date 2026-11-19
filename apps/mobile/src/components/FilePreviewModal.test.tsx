import { act, createContext, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { AssetWorkspaceAssetNotFoundError, EnvironmentId, ThreadId } from "@goat/contracts";

import type { FilePreviewItem } from "./FilePreviewModal.types";

const harness = vi.hoisted(() => ({
  refresh: vi.fn(),
  alert: vi.fn(),
  finished: false,
  progressive: false,
  preview: vi.fn(),
  native: {
    presentFile: vi.fn(),
    presentFiles: vi.fn(),
    updateFile: vi.fn(),
    dismissFile: vi.fn(),
  },
}));
vi.mock("expo", () => ({ requireNativeModule: () => harness.native }));
vi.mock("../state/assets", () => ({ useRefreshAssetUrl: () => harness.refresh }));
vi.mock("./ui/Dialog", () => ({ alert: harness.alert }));
vi.mock("react-native", () => ({ Keyboard: { dismiss: () => {} } }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
}));
vi.mock("./FilePreviewGallery", () => ({ FilePreviewGallery: createContext([]) }));
vi.mock("./FilePreview", () => ({
  supportsProgressiveFilePreview: () => harness.progressive,
  FilePreview: ({
    onPresent,
    source,
  }: {
    onPresent?: (finished: () => boolean) => void;
    source: unknown;
  }) => {
    harness.preview(source);
    useEffect(() => onPresent?.(() => harness.finished), [onPresent]);
    return null;
  },
}));
vi.mock("../lib/localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("../lib/attachmentDownload", () => ({
  downloadAndShareAttachment: vi.fn(),
  nativeViewerErrorMessage: () => "",
  shareLocalAttachment: vi.fn(),
}));

import { FilePreviewModal } from "./FilePreviewModal";

it("names the checked path when the server cannot find the file", async () => {
  const resource = {
    _tag: "media-file" as const,
    threadId: ThreadId.make("thread"),
    path: "missing.png",
  };
  const checkedPath = "/repo/missing.png";
  harness.refresh.mockRejectedValue(
    new AssetWorkspaceAssetNotFoundError({ resource, checkedPath }),
  );
  harness.alert.mockClear();
  const onRequestClose = vi.fn();
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(
        <FilePreviewModal
          source={{ kind: "image", environmentId: EnvironmentId.make("environment"), resource }}
          onRequestClose={onRequestClose}
        />,
      ),
    );
    expect(onRequestClose).toHaveBeenCalledOnce();
    expect(harness.alert).toHaveBeenCalledWith(
      "Could not open preview",
      expect.stringContaining(checkedPath),
    );
    expect(harness.alert.mock.calls[0]?.[1]).not.toMatch(/reconnect/i);
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  ["image", false, true, 1],
  ["image", true, true, 2],
  ["pdf", true, false, 1],
] as const)(
  "reopens the same %s only after native completion (finished: %s, resolved: %s)",
  async (kind, finished, resolved, refreshes) => {
    harness.finished = finished;
    harness.refresh
      .mockReset()
      .mockReturnValue(
        resolved ? Promise.resolve("https://signed.test/preview") : new Promise(() => {}),
      );
    const resource = { _tag: "media-file" as const, threadId: ThreadId.make("thread"), path: "a" };
    const environmentId = EnvironmentId.make("environment");
    const root = createRoot(document.createElement("div"));
    const tap = () =>
      act(async () =>
        root.render(
          <FilePreviewModal source={{ kind, environmentId, resource }} onRequestClose={() => {}} />,
        ),
      );
    try {
      await tap();
      await tap();
      expect(harness.refresh).toHaveBeenCalledTimes(refreshes);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("presents stable gallery pages while originals resolve independently", async () => {
  harness.progressive = true;
  harness.finished = false;
  harness.preview.mockClear();
  harness.alert.mockClear();
  const first = Promise.withResolvers<string>();
  const missing = Promise.withResolvers<string>();
  const gallery = ["first.png", "selected.png", "missing.png"].map((path): FilePreviewItem => ({
    kind: "image",
    name: path,
    environmentId: EnvironmentId.make("environment"),
    resource: { _tag: "media-file", threadId: ThreadId.make("thread"), path },
  }));
  const selected = gallery[1];
  if (!selected) throw new Error("Expected a selected image");
  harness.refresh
    .mockReset()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce("https://signed.test/selected.png")
    .mockReturnValueOnce(missing.promise);
  const onRequestClose = vi.fn();
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(
        <FilePreviewModal source={{ ...selected, gallery }} onRequestClose={onRequestClose} />,
      ),
    );
    expect(harness.preview).toHaveBeenLastCalledWith({
      kind: "image",
      selectedIndex: 1,
      images: [
        expect.objectContaining({ name: "first.png", uri: undefined }),
        expect.objectContaining({ name: "selected.png", uri: "https://signed.test/selected.png" }),
        expect.objectContaining({ name: "missing.png", uri: undefined }),
      ],
    });
    await act(async () => {
      first.resolve("https://signed.test/first.png");
      missing.reject(new Error("The third original is unavailable"));
    });
    expect(harness.preview).toHaveBeenLastCalledWith({
      kind: "image",
      selectedIndex: 1,
      images: [
        expect.objectContaining({ uri: "https://signed.test/first.png" }),
        expect.objectContaining({ uri: "https://signed.test/selected.png" }),
        expect.objectContaining({ uri: null }),
      ],
    });
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(harness.alert).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    harness.progressive = false;
  }
});

it("updates the existing iOS gallery by identifier and ignores completion after unmount", async () => {
  const { FilePreview } = await import("./FilePreview.ios");
  const opening = Promise.withResolvers<void>();
  harness.native.presentFiles.mockReset().mockReturnValue(opening.promise);
  harness.native.updateFile.mockReset().mockResolvedValue(undefined);
  harness.native.dismissFile.mockReset().mockResolvedValue(undefined);
  const onRequestClose = vi.fn();
  const root = createRoot(document.createElement("div"));
  const render = (uri: string | null | undefined) =>
    act(async () =>
      root.render(
        <FilePreview
          source={{
            kind: "image",
            selectedIndex: 1,
            images: [
              { name: "One", sourceIdentifier: "one", uri },
              { name: "Two", sourceIdentifier: "two", uri: "https://signed.test/two.png" },
            ],
          }}
          onRequestClose={onRequestClose}
        />,
      ),
    );
  try {
    await render(undefined);
    await render("https://signed.test/one.png");
    await render("https://signed.test/one.png");
    expect(harness.native.presentFiles).toHaveBeenCalledExactlyOnceWith(
      [null, "https://signed.test/two.png"],
      ["One", "Two"],
      1,
      ["one", "two"],
      expect.any(String),
    );
    const identifier: unknown = harness.native.presentFiles.mock.calls[0]?.[4];
    expect(harness.native.updateFile).toHaveBeenCalledExactlyOnceWith(
      identifier,
      0,
      "https://signed.test/one.png",
    );
    expect(harness.native.presentFile).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    expect(harness.native.dismissFile).toHaveBeenCalledExactlyOnceWith(identifier);
    await act(async () => opening.resolve());
    expect(onRequestClose).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it("passes a resolved iOS document to Quick Look even when the gallery is available", async () => {
  const { FilePreview } = await import("./FilePreview.ios");
  harness.native.presentFile.mockReset().mockResolvedValue(undefined);
  harness.native.dismissFile.mockReset().mockResolvedValue(undefined);
  harness.native.presentFiles.mockClear();
  const onRequestClose = vi.fn();
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(
        <FilePreview
          source={{
            kind: "document",
            uri: "https://signed.test/report.docx",
            name: "report.docx",
            sourceIdentifier: "report",
          }}
          onRequestClose={onRequestClose}
        />,
      ),
    );
    expect(harness.native.presentFile).toHaveBeenCalledExactlyOnceWith(
      "https://signed.test/report.docx",
      "report.docx",
      "report",
      expect.any(String),
    );
    expect(harness.native.presentFiles).not.toHaveBeenCalled();
    expect(onRequestClose).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});

it("uses explicit open attempts when the caller keeps the same source object", async () => {
  harness.progressive = false;
  harness.finished = false;
  harness.refresh.mockReset().mockResolvedValue("https://signed.test/attachment.png");
  const source: FilePreviewItem = {
    kind: "image",
    environmentId: EnvironmentId.make("environment"),
    resource: { _tag: "media-file", threadId: ThreadId.make("thread"), path: "attachment.png" },
  };
  const root = createRoot(document.createElement("div"));
  const render = (attemptId: number) =>
    act(async () =>
      root.render(
        <FilePreviewModal source={source} attemptId={attemptId} onRequestClose={() => {}} />,
      ),
    );
  try {
    await render(1);
    await render(2);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    harness.finished = true;
    await render(2);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    await render(3);
    expect(harness.refresh).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});
