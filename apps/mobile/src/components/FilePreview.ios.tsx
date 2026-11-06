import * as Dialog from "./ui/Dialog";
import { requireNativeModule } from "expo";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import type { ResolvedFilePreviewSource } from "./FilePreviewModal.types";

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
  updateFile(identifier: string, index: number, uri: string | null): Promise<void>;
  dismissFile(identifier: string): Promise<void>;
}>("GoatNativeControls");

function NativeFilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
  const identifier = useId();
  const [presented] = useState(props.source);
  const delivered = useRef<(string | null | undefined)[]>([]);
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onOpenError = useEffectEvent((error: unknown) => {
    if (props.onOpenError) props.onOpenError(error);
    else Dialog.alert("Could not open preview", "The file could not be loaded. Please try again.");
  });

  useEffect(() => {
    let canceled = false;
    const { uri, name, sourceIdentifier, gallery, gallerySlots, selectedIndex } = presented;
    delivered.current = gallerySlots?.map((item) => item.uri) ?? [];
    const presentation = gallerySlots
      ? NativeControls.presentFiles(
          gallerySlots.map((item) => item.uri ?? null),
          gallerySlots.map((item) => item.name ?? "Preview"),
          selectedIndex ?? 0,
          gallerySlots.map((item) => item.sourceIdentifier ?? ""),
          identifier,
        )
      : gallery && gallery.length > 1
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
  }, [presented, identifier]);

  const slots = props.source.gallerySlots;
  // oxlint-disable-next-line goat/react-effect-budget -- deliver resolved gallery items to the native viewer
  useEffect(() => {
    slots?.forEach((item, index) => {
      const uri = item.failed ? null : item.uri;
      if (uri === undefined || delivered.current[index] === uri) return;
      delivered.current[index] = uri;
      void NativeControls.updateFile(identifier, index, uri).catch(() => undefined);
    });
  }, [identifier, slots]);

  return null;
}

export function FilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
  return <NativeFilePreview {...props} />;
}
