import { EnvironmentId, ThreadId } from "@goat/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  url: "https://host/api/assets/expired/image.png",
  refresh: vi.fn<() => Promise<string | null>>(),
}));
vi.mock("../../state/assets", () => ({
  useAssetUrlState: () => ({ _tag: "Success", url: state.url }),
  useRefreshAssetUrl: () => state.refresh,
}));
vi.mock("expo-image", () => ({
  Image: (props: { source: { uri: string }; onError: () => void }) => (
    <img src={props.source.uri} onError={props.onError} />
  ),
}));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));
vi.mock("react-native-svg", () => ({ parse: vi.fn(), SvgAst: () => null }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: (props: {
    children: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
  StyleSheet: { absoluteFill: {} },
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => "Loading",
}));
vi.mock("../../components/FilePreviewGallery", () => ({
  useFilePreviewGallery: () => (source: unknown) => source,
}));
vi.mock("../../components/MediaActionsMenu", () => ({
  MediaActionsMenu: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/ui/NativePresentation", () => ({
  PresentationSource: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../state/mediaActions", () => ({ useMediaActions: () => ({ actions: [] }) }));

import { ThreadMarkdownImage } from "./ThreadMarkdownImage";

let container: HTMLDivElement;
let root: Root;
function renderImage() {
  root.render(
    <ThreadMarkdownImage
      environmentId={EnvironmentId.make("remote")}
      resource={{ _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" }}
      alt="Diagram"
      srcFragment="#view"
      onPressPreview={() => undefined}
    />,
  );
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.url = "https://host/api/assets/expired/image.png";
  state.refresh.mockReset();
  container = document.createElement("div");
  root = createRoot(container);
  act(renderImage);
});
afterEach(() => act(() => root.unmount()));

it("re-signs a failed chat image before remounting it, including an unchanged URL", async () => {
  const first = container.querySelector("img")!;
  act(() => first.dispatchEvent(new Event("error")));
  let finish!: (uri: string) => void;
  state.refresh.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const retry = container.querySelector<HTMLButtonElement>('button[aria-label="Retry image"]')!;
  act(() => retry.click());
  expect(state.refresh).toHaveBeenCalledTimes(1);
  expect(container.querySelector("img")).toBeNull();
  expect(retry.disabled).toBe(true);
  await act(async () => finish(state.url));
  const renewed = container.querySelector("img")!;
  expect(renewed).not.toBe(first);
  const url = new URL(renewed.src);
  expect(url.pathname).toContain("/expired/image.png");
  expect(url.searchParams.has("retry")).toBe(true);
  expect(url.hash).toBe("#view");
});

it("keeps retry available after signing fails and loads a later fresh capability", async () => {
  act(() => container.querySelector("img")!.dispatchEvent(new Event("error")));
  state.refresh.mockRejectedValueOnce(new Error("offline"));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Retry image"]')!.click(),
  );
  expect(container.querySelector("img")).toBeNull();
  state.refresh.mockResolvedValueOnce("https://host/api/assets/new-inode/image.png");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Retry image"]')!.click(),
  );
  expect(container.querySelector("img")!.src).toContain("/new-inode/image.png?");
});

it("clears the failed request after a renewed connection changes the signed URL", () => {
  act(() => container.querySelector("img")!.dispatchEvent(new Event("error")));
  state.url = "https://host/api/assets/reconnected/image.png";
  act(renderImage);
  expect(container.querySelector("img")!.src).toContain("/reconnected/image.png");
});
