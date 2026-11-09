import { BearerConnectionTarget, SshConnectionTarget } from "@goat/client-runtime/connection";
import { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

// A prepared connection that changes like the real atom: subscribers re-render on reconnect.
const connection = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    value: undefined as unknown,
    mounts: 0,
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
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/assets", () => ({
  useAssetUrlState: () => ({ _tag: "Loading" }),
  useRefreshAssetUrl: () => async () => null,
}));
// The player keeps its own playback address, so a remount is what drops the old one.
vi.mock("../../components/MediaVideoPlayer", async () => {
  const { useState } = await import("react");
  return {
    MediaVideoPlayer: (props: {
      uri: string | null;
      thumbnailKey: string;
      unavailable: boolean;
    }) => {
      const [mount] = useState(() => ++connection.mounts);
      return (
        <video
          data-uri={props.uri ?? ""}
          data-thumbnail={props.thumbnailKey}
          data-unavailable={String(props.unavailable)}
          data-mount={mount}
        />
      );
    },
  };
});

import { ThreadMarkdownVideo } from "./ThreadMarkdownVideo";

it("restarts a remote environment's localhost video when a reconnect moves or removes its address", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const player = () => container.querySelector("video")!.dataset;
  connection.mounts = 0;
  connection.value = tailnet;
  act(() =>
    root.render(
      <ThreadMarkdownVideo
        environmentId={environmentId}
        source={{
          type: "media",
          name: "clip.mp4",
          mimeType: "video/mp4",
          uri: "http://localhost:5173/clip.mp4",
        }}
      />,
    ),
  );
  expect(player()).toMatchObject({
    uri: "http://100.65.180.100:5173/clip.mp4",
    unavailable: "false",
    mount: "1",
  });
  expect(player().thumbnail).toContain("100.65.180.100:5173");
  act(() => connection.set(ssh));
  expect(player()).toMatchObject({ uri: "", unavailable: "true", mount: "2" });
  act(() => connection.set(tailnet));
  expect(player()).toMatchObject({ uri: "http://100.65.180.100:5173/clip.mp4", mount: "3" });
});
