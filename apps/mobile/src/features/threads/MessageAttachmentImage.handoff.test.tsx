import { EnvironmentId } from "@goat/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ uri: null as string | null }));
vi.mock("../../state/assets", () => ({
  useAssetUrl: () => state.uri,
  useRefreshAssetUrl: () => vi.fn(),
}));
vi.mock("expo-image", () => ({
  Image: (props: { source: { uri: string }; placeholder?: { uri: string } }) => (
    <img src={props.source.uri} data-placeholder={props.placeholder?.uri} />
  ),
}));
vi.mock("uniwind", () => ({ useResolveClassNames: () => ({}) }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));
vi.mock("../../components/FilePreviewGallery", () => ({
  useFilePreviewGallery: () => (value: unknown) => value,
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <span>Loading</span>,
}));
vi.mock("../../components/ui/NativePresentation", () => ({
  PresentationSource: ({ children }: { children: ReactNode }) => children,
}));
import { MessageAttachmentImage } from "./MessageAttachmentImage";

it("retains local image pixels while the sent attachment URL is unavailable", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <MessageAttachmentImage
        environmentId={EnvironmentId.make("env")}
        attachmentId="server-id"
        name="image.png"
        mimeType="image/png"
        className="image"
        handoff={{ uri: "file:///draft.png", aspectRatio: 2 }}
        onPressPreview={() => {}}
      />,
    ),
  );
  expect(container.querySelector("img")?.getAttribute("src")).toBe("file:///draft.png");
  act(() => root.unmount());
});

it("retains image identity from draft through pending to sent without crossing environments", async () => {
  const { rememberDraftImage, rememberSentImage, sentImageHandoff } =
    await import("../../lib/sentImageHandoff");
  const image = { uri: "file:///draft-2.png", aspectRatio: 2 };
  rememberDraftImage("environment-a", "draft-image", image);
  const pending = sentImageHandoff("environment-a", "message-1", 0, "draft-image");
  expect(pending).toEqual(image);
  if (!pending) throw new Error("pending image missing");
  rememberSentImage("environment-a", "message-1", 0, pending);
  expect(sentImageHandoff("environment-a", "message-1", 0)).toEqual(image);
  expect(sentImageHandoff("environment-b", "message-1", 0, "draft-image")).toBeUndefined();
});
