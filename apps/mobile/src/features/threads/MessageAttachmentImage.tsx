import type { SentImageHandoff } from "../../lib/sentImageHandoff";
import type { EnvironmentId } from "@goat/contracts";
import { Image as ExpoImage } from "expo-image";
import { useMemo, useRef } from "react";
import { Pressable, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { useFilePreviewGallery } from "../../components/FilePreviewGallery";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { PresentationSource } from "../../components/ui/NativePresentation";
import { assetImageSource } from "../../lib/assetImageSource";
import { filePreviewSourceIdentifier } from "../../lib/filePreviewGallery";
import { useAssetUrl, useRefreshAssetUrl } from "../../state/assets";

export function MessageAttachmentImage(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly className: string;
  readonly handoff?: SentImageHandoff;
  readonly onImageLoad?: (image: SentImageHandoff) => void;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const withGallery = useFilePreviewGallery();
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId: props.attachmentId,
      fileName: props.name,
      mimeType: props.mimeType,
    }),
    [props.attachmentId, props.name, props.mimeType],
  );
  const sourceIdentifier = filePreviewSourceIdentifier({
    kind: "image",
    environmentId: props.environmentId,
    resource,
  });
  const uri = useAssetUrl(props.environmentId, resource);
  const refreshAssetUrl = useRefreshAssetUrl(props.environmentId, resource);
  const retriedImage = useRef(false);
  const imageStyle = useResolveClassNames(props.className);

  if (uri === null && props.handoff === undefined) {
    return (
      <View className={`${props.className} items-center justify-center`}>
        <AppActivityIndicator />
      </View>
    );
  }

  return (
    <PresentationSource identifier={sourceIdentifier}>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`Open ${props.name}`}
        onPress={() =>
          props.onPressPreview(
            withGallery({
              kind: "image",
              environmentId: props.environmentId,
              resource,
              name: props.name,
              sourceIdentifier,
              actionsSource: {
                name: props.name,
                mimeType: props.mimeType,
                environmentId: props.environmentId,
                resource,
              },
            }),
          )
        }
      >
        <ExpoImage
          source={
            uri === null
              ? { uri: props.handoff?.uri }
              : assetImageSource(props.environmentId, resource, uri)
          }
          placeholder={props.handoff ? { uri: props.handoff.uri } : undefined}
          placeholderContentFit="cover"
          cachePolicy="memory-disk"
          style={imageStyle}
          contentFit="cover"
          onLoad={(event) => {
            retriedImage.current = false;
            if (props.handoff)
              props.onImageLoad?.({
                uri: props.handoff.uri,
                aspectRatio: event.source.width / event.source.height,
              });
          }}
          onError={() => {
            if (retriedImage.current) return;
            retriedImage.current = true;
            void refreshAssetUrl();
          }}
        />
      </Pressable>
    </PresentationSource>
  );
}
