import { EnvironmentId, ThreadId } from "@goat/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  focused: true,
  refresh: vi.fn<() => Promise<string | null>>(),
  present: vi.fn<(...args: unknown[]) => Promise<void>>(),
  dismiss: vi.fn(() => Promise.resolve()),
  loadLocal: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => mocks.focused }));
vi.mock("expo", () => ({
  requireNativeModule: () => ({
    presentVideo: mocks.present,
    dismissVideo: mocks.dismiss,
    addListener: () => ({ remove: () => {} }),
  }),
}));
vi.mock("react-native", () => ({ Keyboard: { dismiss: () => {} } }));
vi.mock("./ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../state/assets", () => ({ useRefreshAssetUrl: () => mocks.refresh }));
vi.mock("../state/session", () => ({ usePreparedConnection: () => ({ _tag: "Some" }) }));
vi.mock("../lib/localAttachmentPreview", () => ({ loadLocalAttachmentPreview: mocks.loadLocal }));
vi.mock("../lib/videoAudioSession", () => ({
  fullscreenVideoOpened: () => {},
  fullscreenVideoClosed: () => {},
}));
vi.mock("../lib/audioSession", () => ({
  acquireAudioSession: () => ({}),
  activateAudioSession: async () => true,
  isAudioSessionOwner: () => true,
  releaseAudioSession: async () => {},
}));

import { VideoPreviewModal, type VideoPreviewSource } from "./VideoPreviewModal.ios";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.focused = true;
  mocks.refresh.mockReset();
  mocks.present.mockReset();
  mocks.dismiss.mockClear();
  mocks.loadLocal.mockReset();
  mocks.alert.mockClear();
  const playback = Promise.withResolvers<void>();
  mocks.present.mockReturnValue(playback.promise);
  const root = createRoot(document.createElement("div"));
  const close = vi.fn();
  const render = (source: VideoPreviewSource | null) =>
    act(async () => root.render(<VideoPreviewModal source={source} onRequestClose={close} />));
  const source: VideoPreviewSource = {
    type: "media",
    name: "clip.mp4",
    mimeType: "video/mp4",
    environmentId: EnvironmentId.make("destination"),
    resource: { _tag: "media-file", threadId: ThreadId.make("video"), path: "/repo/clip.mp4" },
    srcFragment: "#t=2",
  };
  return { root, playback, close, render, source };
}

it("mints a new URL for every presentation instead of latching a suspended session's cached URL", async () => {
  const { root, playback, render, source } = setup();
  try {
    mocks.refresh.mockResolvedValueOnce("https://destination.test/api/assets/fresh");
    await render(source);
    expect(mocks.present.mock.calls[0]?.[0]).toBe("https://destination.test/api/assets/fresh#t=2");
    await render(null);
    mocks.refresh.mockResolvedValueOnce("https://destination.test/api/assets/reopened");
    await render(source);
    expect(mocks.present.mock.calls[1]?.[0]).toBe(
      "https://destination.test/api/assets/reopened#t=2",
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => {
      playback.resolve();
    });
    await act(async () => root.unmount());
  }
});

it("does not present a denied URL or an obsolete signing result after the source changes", async () => {
  const { root, playback, close, render, source } = setup();
  const signing = Promise.withResolvers<string | null>();
  try {
    mocks.refresh.mockReturnValueOnce(signing.promise);
    await render(source);
    mocks.refresh.mockResolvedValueOnce(null);
    await render({ ...source, environmentId: EnvironmentId.make("other-destination") });
    expect(mocks.present).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    await act(async () => signing.resolve("https://old.test/api/assets/obsolete"));
    expect(mocks.present).not.toHaveBeenCalled();
  } finally {
    playback.resolve();
    await act(async () => root.unmount());
  }
});

it("keeps a local file leased through metadata changes and blur until native dismissal completes", async () => {
  const { root, playback, render } = setup();
  const dispose = vi.fn();
  const source: VideoPreviewSource = {
    type: "local",
    attachment: {
      type: "file",
      id: "local",
      fileUri: "file:///draft/clip.mp4",
      name: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 12,
    },
  };
  mocks.loadLocal.mockResolvedValue({ uri: source.attachment.fileUri, dispose });
  try {
    await render(source);
    await render({ ...source, attachment: { ...source.attachment, name: "renamed.mp4" } });
    expect(mocks.loadLocal).toHaveBeenCalledTimes(1);
    expect(mocks.present).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    mocks.focused = false;
    await render(source);
    expect(mocks.dismiss).toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    await act(async () => playback.resolve());
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    playback.resolve();
    await act(async () => root.unmount());
  }
});
