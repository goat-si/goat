import { createContext, useContext } from "react";
import type { EnvironmentId } from "@goat/contracts";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { useEnvironmentMediaUri } from "../../lib/environmentMediaUri";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import {
  mediaVideoPreviewUri,
  mediaVideoThumbnailKey,
  type MediaVideoPreviewSource,
} from "../../lib/videoPreviewSource";

export const ThreadMediaVisibleContext = createContext(false);

export function ThreadMarkdownVideo(props: {
  readonly source: MediaVideoPreviewSource;
  /** The environment a URL source came from, so its loopback address resolves to that machine. */
  readonly environmentId?: EnvironmentId | undefined;
  readonly thumbnailVisible?: boolean;
  readonly onPlaybackStart?: () => void;
}) {
  const { source } = props;
  const feedVisible = useContext(ThreadMediaVisibleContext);
  const visible = props.thumbnailVisible ?? feedVisible;
  const asset = useAssetUrlState(
    "environmentId" in source ? source.environmentId : null,
    "resource" in source ? source.resource : null,
  );
  const refreshAssetUrl = useRefreshAssetUrl(
    "environmentId" in source ? source.environmentId : null,
    "resource" in source ? source.resource : null,
  );
  const routed = useEnvironmentMediaUri(
    props.environmentId ?? null,
    "uri" in source ? source.uri : "",
  );
  // A reconnect can move or remove the address, so the thumbnail and an open player start over.
  const thumbnailKey = mediaVideoThumbnailKey(
    "uri" in source && routed.uri !== null ? { ...source, uri: routed.uri } : source,
  );
  const playerKey =
    "uri" in source ? `${thumbnailKey}|${routed.uri ?? "unavailable"}` : thumbnailKey;
  const uri =
    "uri" in source
      ? routed.uri
      : mediaVideoPreviewUri(source, asset._tag === "Success" ? asset.url : null);
  return (
    <MediaVideoPlayer
      key={playerKey}
      uri={uri}
      resolvePlaybackUri={
        "resource" in source
          ? async () => mediaVideoPreviewUri(source, await refreshAssetUrl())
          : undefined
      }
      name={source.name}
      thumbnailKey={thumbnailKey}
      thumbnailVisible={visible}
      visible={visible}
      onPlaybackStart={props.onPlaybackStart}
      unavailable={"resource" in source ? asset._tag === "Failure" : routed.uri === null}
      actionsSource={source.actionsSource}
    />
  );
}
