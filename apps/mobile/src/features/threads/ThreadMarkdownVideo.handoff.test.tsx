import { EnvironmentId } from "@goat/contracts";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ mounted: 0, key: "" }));
vi.mock("../../components/MediaVideoPlayer", () => ({
  MediaVideoPlayer: (props: { thumbnailKey: string }) => {
    state.key = props.thumbnailKey;
    useEffect(() => {
      state.mounted += 1;
    }, []);
    return <div />;
  },
}));
vi.mock("../../state/assets", () => ({
  useAssetUrlState: () => ({ _tag: "Success", url: "https://host/video" }),
  useRefreshAssetUrl: () => vi.fn(),
}));
vi.mock("../../lib/environmentMediaUri", () => ({
  useEnvironmentMediaUri: (_id: unknown, uri: string) => ({ uri }),
  routedActionsSource: () => undefined,
}));
import { ThreadMarkdownVideo } from "./ThreadMarkdownVideo";

it("keeps the player and poster identity when a queued video becomes a sent attachment", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.mounted = 0;
  const root = createRoot(document.createElement("div"));
  const local = {
    type: "media" as const,
    name: "clip.mp4",
    mimeType: "video/mp4",
    uri: "file:///clip.mp4",
  };
  const sent = {
    type: "media" as const,
    name: "clip.mp4",
    mimeType: "video/mp4",
    environmentId: EnvironmentId.make("env"),
    resource: {
      _tag: "attachment" as const,
      attachmentId: "server-id",
      fileName: "clip.mp4",
      mimeType: "video/mp4",
    },
  };
  act(() => root.render(<ThreadMarkdownVideo source={local} thumbnailKey="stable" />));
  act(() => root.render(<ThreadMarkdownVideo source={sent} thumbnailKey="stable" />));
  expect(state.mounted).toBe(1);
  expect(state.key).toBe("stable");
  act(() => root.unmount());
});
