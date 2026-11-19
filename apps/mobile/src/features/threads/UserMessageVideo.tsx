import type { ChatFileAttachment, EnvironmentId } from "@goat/contracts";
import { useId, useState } from "react";
import { View } from "react-native";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import type { FileBackedComposerAttachment } from "../../lib/composerImages";
import { useLocalAttachmentPreview } from "../../lib/useLocalAttachmentPreview";
import {
  attachmentVideoPreviewSource,
  mediaVideoThumbnailKey,
  type MediaVideoPreviewSource,
} from "../../lib/videoPreviewSource";
import { ThreadMarkdownVideo } from "./ThreadMarkdownVideo";

export function UserMessageVideo(props: {
  readonly environmentId: EnvironmentId;
  readonly messageId: string;
  readonly index: number;
  readonly local: FileBackedComposerAttachment | null;
  readonly uploaded: ChatFileAttachment | null;
  readonly onPlaybackStart: () => void;
}) {
  const sourceIdentifier = useId();
  const preview = useLocalAttachmentPreview(props.local);
  const current: MediaVideoPreviewSource | null =
    props.local !== null && preview.uri !== null
      ? { type: "media", name: props.local.name, mimeType: props.local.mimeType, uri: preview.uri }
      : props.uploaded !== null
        ? attachmentVideoPreviewSource(props.environmentId, props.uploaded, sourceIdentifier)
        : null;
  const [shown, setShown] = useState(current);
  if (
    current !== null &&
    (shown === null || mediaVideoThumbnailKey(current) !== mediaVideoThumbnailKey(shown))
  )
    setShown(current);
  const source = current ?? shown;
  if (source === null)
    return (
      <View className="aspect-video items-center justify-center bg-black">
        {preview.error ? (
          <Text className="p-3 text-center text-xs text-white/70">{preview.error.message}</Text>
        ) : (
          <AppActivityIndicator />
        )}
      </View>
    );
  return (
    <ThreadMarkdownVideo
      source={source}
      thumbnailKey={JSON.stringify([
        "user-message-video",
        props.environmentId,
        props.messageId,
        props.index,
      ])}
      onPlaybackStart={props.onPlaybackStart}
    />
  );
}
