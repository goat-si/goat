import { RegistryContext } from "@effect/atom-react";
import { BearerConnectionTarget, SshConnectionTarget } from "@goat/client-runtime/connection";
import * as Option from "effect/Option";
import { AtomRegistry } from "effect/reactivity";
import { fetch } from "expo/fetch";
import { parse } from "react-native-svg";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  url: "https://host/api/assets/expired/image.png",
  load: (_event: { source: { width: number; height: number } }) => {},
  refresh: vi.fn<() => Promise<string | null>>(),
}));
// A prepared connection that changes like the real atom: subscribers re-render on reconnect.
const connection = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    value: undefined as unknown,
    set(next: unknown) {
      this.value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock("../../state/session", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePreparedConnection: () =>
      useSyncExternalStore(
        (listener) => connection.subscribe(listener),
        () => connection.value,
      ),
  };
});
vi.mock("../../state/assets", () => ({
  useAssetUrlState: () => ({ _tag: "Success", url: state.url }),
  useRefreshAssetUrl: () => state.refresh,
}));
vi.mock("expo-image", () => ({
  Image: (props: { source: { uri: string }; onError: () => void; onLoad: typeof state.load }) => {
    state.load = props.onLoad;
    return <img src={props.source.uri} onError={props.onError} />;
  },
}));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));
vi.mock("react-native-svg", () => ({ parse: vi.fn(), SvgAst: () => null }));
vi.mock("react-native", () => ({
  View: ({ children, style }: { children: ReactNode; style?: unknown }) => (
    <div data-style={JSON.stringify(style)}>{children}</div>
  ),
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

import {
  MarkdownImageAvailableWidthContext,
  ThreadMarkdownDirectImage,
  ThreadMarkdownImage,
  ThreadMarkdownImageView,
} from "./ThreadMarkdownImage";

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

it("keeps the first decoded image dimensions until the resource revision changes", () => {
  const view = (sourceKey: string) => (
    <MarkdownImageAvailableWidthContext value={345}>
      <ThreadMarkdownImageView
        uri="https://example.test/image.png"
        sourceKey={sourceKey}
        unavailable={false}
        alt={null}
        onPressPreview={() => {}}
      />
    </MarkdownImageAvailableWidthContext>
  );
  const frame = () =>
    [...container.querySelectorAll<HTMLElement>("div[data-style]")]
      .map((el) => JSON.parse(el.dataset.style ?? "null") as { width?: number } | null)
      .find((style) => typeof style?.width === "number");
  act(() => root.render(view("image@1")));
  act(() => state.load({ source: { width: 970, height: 567 } }));
  const first = frame();
  expect(first).toBeDefined();
  act(() => state.load({ source: { width: 969, height: 567 } }));
  expect(frame()).toEqual(first);
  act(() => root.render(view("image@2")));
  act(() => state.load({ source: { width: 500, height: 500 } }));
  expect(frame()).not.toEqual(first);
});

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

it("retries failed SVG mounts and reuses successful fetches and parses", async () => {
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      queueMicrotask(task);
      return () => {};
    },
  });
  const fetchSvg = vi.mocked(fetch);
  fetchSvg.mockReset();
  const parseSvg = vi.mocked(parse);
  parseSvg.mockReset();
  parseSvg.mockReturnValue({ props: {} } as ReturnType<typeof parse>);
  const view = (mounted: boolean) => (
    <RegistryContext.Provider value={registry}>
      {mounted ? (
        <ThreadMarkdownImageView
          uri="https://example.test/cached.svg"
          sourceKey="attachment:svg"
          unavailable={false}
          alt={null}
          format="svg"
          onPressPreview={() => {}}
        />
      ) : null}
    </RegistryContext.Provider>
  );
  try {
    fetchSvg.mockRejectedValueOnce(new Error("offline"));
    await act(async () => root.render(view(true)));
    await vi.waitFor(() => expect(container.textContent).toContain("Image unavailable"));
    await act(async () => root.render(view(false)));
    fetchSvg.mockResolvedValue({ ok: true, status: 200, text: async () => "<svg />" } as Awaited<
      ReturnType<typeof fetch>
    >);
    await act(async () => root.render(view(true)));
    await vi.waitFor(() => {
      expect(container.textContent).not.toContain("Loading image");
      expect(container.textContent).not.toContain("Image unavailable");
    });
    expect(fetchSvg).toHaveBeenCalledTimes(2);
    expect(parseSvg).toHaveBeenCalledTimes(1);
    await act(async () => root.render(view(false)));
    await act(async () => root.render(view(true)));
    expect(container.textContent).not.toContain("Image unavailable");
    expect(fetchSvg).toHaveBeenCalledTimes(2);
    expect(parseSvg).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.render(null));
    registry.dispose();
  }
});

it("does not parse an obsolete SVG response after its last reader unmounts", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      queueMicrotask(task);
      return () => {};
    },
  });
  const root = createRoot(document.createElement("div"));
  const fetchSvg = vi.mocked(fetch);
  const parseSvg = vi.mocked(parse);
  fetchSvg.mockReset();
  parseSvg.mockClear();
  const body = Promise.withResolvers<string>();
  fetchSvg.mockResolvedValue({ ok: true, status: 200, text: () => body.promise } as never);
  try {
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <ThreadMarkdownImageView
            uri="https://example.test/obsolete.svg"
            sourceKey="attachment:obsolete"
            unavailable={false}
            alt={null}
            format="svg"
            onPressPreview={() => {}}
          />
        </RegistryContext.Provider>,
      ),
    );
    expect(fetchSvg).toHaveBeenCalledOnce();
    const signal = fetchSvg.mock.calls[0]![1]!.signal!;
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    await act(async () => body.resolve("<svg />"));
    expect(parseSvg).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    registry.dispose();
  }
});
it("follows a reconnect for a remote environment's localhost image, both ways", () => {
  const environmentId = EnvironmentId.make("remote");
  const remote = { environmentId, label: "Build box" };
  const tailnet = Option.some({
    httpBaseUrl: "http://100.65.180.100:3773",
    target: new BearerConnectionTarget({ ...remote, connectionId: "saved:box" }),
  });
  const ssh = Option.some({
    httpBaseUrl: "http://127.0.0.1:41234",
    target: new SshConnectionTarget({ ...remote, connectionId: "ssh:box" }),
  });
  connection.value = ssh;
  act(() =>
    root.render(
      <ThreadMarkdownDirectImage
        environmentId={environmentId}
        uri="http://localhost:5173/shot.png"
        alt={null}
        onPressPreview={() => undefined}
      />,
    ),
  );
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("localhost:5173 is on Build box");
  act(() => connection.set(tailnet));
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "http://100.65.180.100:5173/shot.png",
  );
  act(() => connection.set(ssh));
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("localhost:5173 is on Build box");
});
