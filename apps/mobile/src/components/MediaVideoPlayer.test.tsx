import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: Record<string, unknown>) => void>>();
  const emit = (event: string, payload: Record<string, unknown>) => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };
  const player = {
    status: "readyToPlay" as "readyToPlay" | "error",
    playing: false,
    currentTime: 0,
    volume: 1,
    muted: false,
    playbackRate: 1,
    pause: vi.fn(),
    play: vi.fn(),
    replaceAsync: vi.fn<(source: { uri: string }) => Promise<void>>(),
    addListener: (event: string, listener: (payload: Record<string, unknown>) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return { remove: () => listeners.get(event)?.delete(listener) };
    },
  };
  return { player, emit, listeners, refresh: vi.fn<() => Promise<string | null>>() };
});
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("expo", async () => {
  const { useEffect, useState } = await import("react");
  return {
    requireOptionalNativeModule: () => null,
    useEvent: (_player: unknown, event: string, initial: Record<string, unknown>) => {
      const [state, setState] = useState(initial);
      useEffect(() => {
        const subscription = mock.player.addListener(event, setState);
        return () => {
          subscription.remove();
        };
      }, [event]);
      return state;
    },
  };
});
vi.mock("expo-audio", () => ({
  AudioModule: { setAudioSessionOwner: vi.fn() },
  setAudioModeAsync: vi.fn(async () => {}),
  setIsAudioActiveAsync: vi.fn(async () => {}),
}));
vi.mock("expo-video", () => ({ useVideoPlayer: () => mock.player, VideoView: () => <video /> }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
}));
vi.mock("./ui/AppText", () => ({ AppText: "span" }));
vi.mock("./ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => "Loading video" }));
vi.mock("./VideoThumbnailImage", () => ({ VideoThumbnailImage: () => null }));
vi.mock("./MediaActionsMenu", () => ({
  MediaActionsMenu: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../state/mediaActions", () => ({
  useMediaActions: () => ({ sharing: false, actions: [] }),
}));

import { MediaVideoPlayer } from "./MediaVideoPlayer";

let container: HTMLDivElement;
let root: Root;
const original = "https://host/api/assets/old/video.mp4";
function renderPlayer(uri = original) {
  root.render(
    <MediaVideoPlayer
      uri={uri}
      resolvePlaybackUri={mock.refresh}
      name="Video"
      thumbnailKey="video"
      expanded
      autoPlay
    />,
  );
}
function failPlayback() {
  mock.player.status = "error";
  mock.player.playing = false;
  mock.emit("statusChange", { status: "error" });
  mock.emit("playingChange", { isPlaying: false });
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mock.listeners.clear();
  Object.assign(mock.player, {
    status: "readyToPlay",
    playing: false,
    currentTime: 0,
    volume: 1,
    muted: false,
    playbackRate: 1,
  });
  mock.refresh.mockReset().mockResolvedValue(original);
  mock.player.play.mockReset().mockImplementation(() => {
    mock.player.playing = true;
    mock.emit("playingChange", { isPlaying: true });
  });
  mock.player.pause.mockReset().mockImplementation(() => {
    mock.player.playing = false;
    mock.emit("playingChange", { isPlaying: false });
  });
  mock.player.replaceAsync.mockReset().mockImplementation(async () => {
    Object.assign(mock.player, {
      status: "readyToPlay",
      currentTime: 0,
      volume: 1,
      muted: false,
      playbackRate: 1,
    });
    mock.emit("statusChange", { status: "readyToPlay" });
  });
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => renderPlayer());
});
afterEach(() => act(() => root.unmount()));

it("refreshes once automatically and restores the playhead, sound and playback rate", async () => {
  Object.assign(mock.player, { currentTime: 123, volume: 0.4, muted: true, playbackRate: 1.5 });
  mock.refresh.mockResolvedValue("https://host/api/assets/renewed/video.mp4");
  await act(async () => failPlayback());
  expect(mock.refresh).toHaveBeenCalledTimes(2);
  expect(mock.player.replaceAsync).toHaveBeenLastCalledWith({
    uri: "https://host/api/assets/renewed/video.mp4",
    contentType: "progressive",
  });
  expect(mock.player.currentTime).toBe(123);
  expect(mock.player.volume).toBe(0.4);
  expect(mock.player.muted).toBe(true);
  expect(mock.player.playbackRate).toBe(1.5);
  expect(mock.player.playing).toBe(true);

  await act(async () => failPlayback());
  expect(mock.refresh).toHaveBeenCalledTimes(2);
  expect(container.querySelector('button[aria-label="Retry video"]')).not.toBeNull();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Retry video"]')!.click(),
  );
  expect(mock.refresh).toHaveBeenCalledTimes(3);
  expect(mock.player.currentTime).toBe(123);
});

it("adopts a new signed URL while paused without losing position or starting playback", async () => {
  mock.player.currentTime = 42;
  act(() => mock.player.pause());
  mock.player.play.mockClear();
  await act(async () => renderPlayer("https://host/api/assets/new/video.mp4"));
  expect(mock.player.replaceAsync).toHaveBeenLastCalledWith({
    uri: "https://host/api/assets/new/video.mp4",
    contentType: "progressive",
  });
  expect(mock.player.currentTime).toBe(42);
  expect(mock.player.play).not.toHaveBeenCalled();
});

it("keeps a failed automatic renewal retryable and retains position for the manual retry", async () => {
  mock.player.currentTime = 75;
  mock.refresh.mockRejectedValueOnce(new Error("disconnected"));
  await act(async () => failPlayback());
  expect(container.querySelector('button[aria-label="Retry video"]')).not.toBeNull();
  mock.refresh.mockResolvedValueOnce("https://host/api/assets/connected/video.mp4");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Retry video"]')!.click(),
  );
  expect(mock.player.currentTime).toBe(75);
  expect(mock.player.playing).toBe(true);
});
