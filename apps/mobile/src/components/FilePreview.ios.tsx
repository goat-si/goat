import * as Dialog from "./ui/Dialog";
import { requireNativeModule } from "expo";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import type { FilePreviewViewerProps } from "./FilePreviewModal.types";

const NativeControls = requireNativeModule<{
  presentFile(
    uri: string,
    name: string,
    sourceIdentifier: string,
    identifier: string,
  ): Promise<void>;
  presentFiles(
    uris: readonly (string | null)[],
    names: readonly string[],
    selectedIndex: number,
    sourceIdentifiers: readonly string[],
    identifier: string,
  ): Promise<void>;
  updateFile?(identifier: string, index: number, uri: string | null): Promise<void>;
  dismissFile(identifier: string): Promise<void>;
  isFilePreviewFinished?(identifier: string): boolean;
}>("GoatNativeControls");

export function supportsProgressiveFilePreview() {
  return typeof NativeControls.updateFile === "function";
}

export function FilePreview(props: FilePreviewViewerProps) {
  const [presented] = useState(props.source);
  const delivered = useRef<(string | null | undefined)[]>([]);
  const identifier = useId();
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onPresent = useEffectEvent((isFinished: () => boolean) => props.onPresent?.(isFinished));
  const onOpenError = useEffectEvent((error: unknown) => {
    if (props.onOpenError) props.onOpenError(error);
    else Dialog.alert("Could not open preview", "The file could not be loaded. Please try again.");
  });

  useEffect(() => {
    let canceled = false;
    let presentation: Promise<void>;
    if ("images" in presented) {
      const { images, selectedIndex } = presented;
      const initialUrls = images.map(({ uri }) => uri ?? null);
      delivered.current = images.map(({ uri }) => uri ?? undefined);
      presentation = NativeControls.presentFiles(
        initialUrls,
        images.map(({ name }) => name),
        selectedIndex,
        images.map(({ sourceIdentifier }) => sourceIdentifier),
        identifier,
      );
    } else {
      const { uri, name, sourceIdentifier, gallery } = presented;
      presentation =
        gallery && gallery.length > 1
          ? NativeControls.presentFiles(
              gallery.map((item) => item.uri),
              gallery.map((item) => item.name ?? "Preview"),
              Math.max(
                0,
                gallery.findIndex((item) => item.uri === uri),
              ),
              gallery.map((item) => item.sourceIdentifier ?? ""),
              identifier,
            )
          : NativeControls.presentFile(uri, name ?? "Preview", sourceIdentifier ?? "", identifier);
    }
    onPresent(() => NativeControls.isFilePreviewFinished?.(identifier) === true);
    void presentation
      .catch((error: unknown) => {
        if (!canceled) onOpenError(error);
      })
      .finally(() => {
        if (!canceled) onRequestClose();
      });
    return () => {
      canceled = true;
      void NativeControls.dismissFile(identifier).catch(() => undefined);
    };
  }, [identifier, presented]);

  const { source } = props;
  // oxlint-disable-next-line goat/react-effect-budget -- Deliver newly resolved URLs to the open UIKit viewer.
  useEffect(() => {
    if (!("images" in source)) return;
    source.images.forEach(({ uri }, index) => {
      if (uri === undefined || delivered.current[index] === uri) return;
      delivered.current[index] = uri;
      void NativeControls.updateFile?.(identifier, index, uri).catch(() => undefined);
    });
  }, [identifier, source]);

  return null;
}
