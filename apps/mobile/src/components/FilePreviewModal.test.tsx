import { act, createContext, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { AssetWorkspaceAssetNotFoundError, EnvironmentId, ThreadId } from "@goat/contracts";

const harness = vi.hoisted(() => ({
  refresh: vi.fn(),
  alert: vi.fn(),
  finished: false,
}));
vi.mock("../state/assets", () => ({ useRefreshAssetUrl: () => harness.refresh }));
vi.mock("./ui/Dialog", () => ({ alert: harness.alert }));
vi.mock("react-native", () => ({ Keyboard: { dismiss: () => {} } }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
}));
vi.mock("./FilePreviewGallery", () => ({ FilePreviewGallery: createContext([]) }));
vi.mock("./FilePreview", () => ({
  FilePreview: ({ onPresent }: { onPresent?: (finished: () => boolean) => void }) => {
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
