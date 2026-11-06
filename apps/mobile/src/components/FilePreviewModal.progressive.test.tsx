import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, SOURCE_CONTROL_MEDIA_ASSET } from "@goat/contracts";

const state = vi.hoisted(() => ({ refresh: vi.fn(), previews: [] as unknown[], mounts: 0 }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" }, Keyboard: { dismiss: vi.fn() } }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
}));
vi.mock("../state/assets", () => ({
  useRefreshAssetUrl: (_id: unknown, resource: { url: string }) => () =>
    state.refresh(resource.url),
}));
vi.mock("../lib/localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("../lib/attachmentDownload", () => ({
  downloadAndShareAttachment: vi.fn(),
  nativeViewerErrorMessage: () => "",
  shareLocalAttachment: vi.fn(),
}));
vi.mock("./ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("./FilePreview", async () => {
  const { useState } = await import("react");
  return {
    FilePreview: (props: { source: unknown }) => {
      useState(() => state.mounts++);
      state.previews.push(props.source);
      return null;
    },
  };
});
import { FilePreviewModal } from "./FilePreviewModal";
import type { FilePreviewItem } from "./FilePreviewModal.types";

it("opens the selected image before a sibling resolves and keeps its gallery slot", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const slow = Promise.withResolvers<string>();
  state.previews.length = 0;
  state.mounts = 0;
  state.refresh.mockImplementation((url: string) =>
    url.endsWith("slow") ? slow.promise : Promise.resolve("https://signed.test/selected"),
  );
  const image = (url: string): FilePreviewItem => ({
    kind: "image",
    environmentId: EnvironmentId.make("env"),
    resource: { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd: "/repo", url },
  });
  const selected = image("selected");
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(
        <FilePreviewModal
          source={{ ...selected, gallery: [image("slow"), selected] }}
          onRequestClose={() => {}}
        />,
      ),
    );
    expect(state.previews.at(-1)).toMatchObject({
      selectedIndex: 1,
      gallerySlots: [{ name: expect.any(String) }, { uri: "https://signed.test/selected" }],
    });
    await act(async () => slow.resolve("https://signed.test/slow"));
    expect(state.previews.at(-1)).toMatchObject({
      gallerySlots: [{ uri: "https://signed.test/slow" }, { uri: "https://signed.test/selected" }],
    });
    expect(state.mounts).toBe(1);
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
