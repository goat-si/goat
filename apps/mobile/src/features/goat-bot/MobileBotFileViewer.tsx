import type { ChannelBotArtifact, EnvironmentId } from "@goat/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Image, Modal, Pressable, Text, View } from "react-native";

import { type ImagePreview, openBotLibraryFile } from "./openBotLibraryFile";

const withoutKey = (record: Readonly<Record<string, string>>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key));

/**
 * Opens GOAT Bot's Library files the one way the app does: an image in the viewer this hook
 * draws, any other file in the share sheet, and a failure as a message by its path. The Library
 * and the chat's file cards share it. Reads stop and an unshared copy goes when the owner unmounts.
 */
export function useBotFileOpener(
  environmentId: EnvironmentId | null,
  botName: string,
): {
  readonly open: (file: ChannelBotArtifact) => Promise<void>;
  readonly opening: string | null;
  readonly messages: Readonly<Record<string, string>>;
  readonly viewer: ReactNode;
} {
  const [opening, setOpening] = useState<string | null>(null);
  const [messages, setMessages] = useState<Readonly<Record<string, string>>>({});
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const previewRef = useRef<ImagePreview | null>(null);
  // oxlint-disable-next-line goat/react-effect-budget -- Reads and cache copies outlive a render; stop the read and drop an unshared copy when the owner goes away.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      previewRef.current?.file.dispose();
      previewRef.current = null;
    };
  }, []);
  const show = (next: ImagePreview | null) => {
    previewRef.current = next;
    setPreviewError(null);
    setPreview(next);
  };
  const closePreview = () => {
    previewRef.current?.file.dispose();
    show(null);
  };
  const open = async (file: ChannelBotArtifact) => {
    const signal = lifetime.current?.signal;
    if (environmentId === null || signal === undefined || signal.aborted) return;
    setOpening(file.relativePath);
    setMessages((current) => withoutKey(current, file.relativePath));
    const result = await openBotLibraryFile(environmentId, file.relativePath, signal, botName);
    if (signal.aborted) {
      if (result.kind === "image") result.preview.file.dispose();
      return;
    }
    setOpening(null);
    if (result.kind === "image") show(result.preview);
    else if (result.kind === "message")
      setMessages((current) => ({ ...current, [file.relativePath]: result.message }));
  };
  const viewer = (
    <Modal
      visible={preview !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={closePreview}
    >
      <View className="flex-1 gap-3 bg-screen px-4 pt-4">
        <View className="flex-row gap-4">
          <Pressable
            accessibilityRole="button"
            onPress={closePreview}
            className="min-h-[44px] min-w-[44px] justify-center px-2"
          >
            <Text className="text-foreground">Close</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              const signal = lifetime.current?.signal;
              if (!preview || !signal) return;
              setPreviewError(null);
              void preview.file.share(signal).catch((error: unknown) => {
                if (!signal.aborted)
                  setPreviewError(
                    error instanceof Error
                      ? error.message
                      : "Could not open the share sheet. Try again.",
                  );
              });
            }}
            className="min-h-[44px] min-w-[44px] justify-center px-2"
          >
            <Text className="text-foreground">Share</Text>
          </Pressable>
        </View>
        {previewError !== null ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {previewError}
          </Text>
        ) : null}
        {preview ? (
          <Image
            source={{ uri: preview.file.uri }}
            accessibilityLabel={preview.name}
            resizeMode="contain"
            className="flex-1"
          />
        ) : null}
      </View>
    </Modal>
  );
  return { open, opening, messages, viewer };
}
