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
  const thumbnailKey = mediaVideoThumbnailKey(source);
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
  const uri =
    "uri" in source
      ? routed.uri
      : mediaVideoPreviewUri(source, asset._tag === "Success" ? asset.url : null);
  return (
    <MediaVideoPlayer
      key={thumbnailKey}
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
