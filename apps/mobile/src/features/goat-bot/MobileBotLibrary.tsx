import {
  botArtifactName,
  botArtifactOpenMessage,
  botArtifactSizeLabel,
  botArtifactsFailure,
  readWholeBotArtifact,
} from "@goat/client-runtime/goatBot";
import { runAtomCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type {
  ChannelBotArtifact,
  ChannelReadBotArtifactInput,
  EnvironmentId,
} from "@goat/contracts";
import { useEffect, useRef, useState } from "react";
import { Image, Modal, Pressable, Text, View } from "react-native";
import type { AttachmentPreviewFile } from "../../lib/attachmentDownload";
import { appAtomRegistry } from "../../state/atom-registry";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentQuery } from "../../state/query";

interface ImagePreview {
  readonly name: string;
  readonly file: AttachmentPreviewFile;
}

/**
 * Files GOAT Bot's workers saved. An image opens here; other files go to the share sheet. A copy
 * handed to another app stays for it and is swept from the cache later; any other copy is deleted.
 */
export function MobileBotLibrary(props: {
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
  readonly supported: boolean;
}) {
  const { environmentId, connected, supported } = props;
  const readable = environmentId !== null && connected && supported;
  const files = useEnvironmentQuery(
    readable ? channelEnvironment.listBotArtifacts({ environmentId, input: {} }) : null,
  );
  const refresh = files.refresh;
  // oxlint-disable-next-line goat/react-effect-budget -- Workers save files on the server at any time; read the folder again each time the tab opens.
  useEffect(() => {
    if (readable) refresh();
  }, [readable, refresh]);
  const [opening, setOpening] = useState<string | null>(null);
  const [messages, setMessages] = useState<Readonly<Record<string, string>>>({});
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const previewRef = useRef<ImagePreview | null>(null);
  // oxlint-disable-next-line goat/react-effect-budget -- Reads and cache copies outlive a render; stop the read and drop an unshared copy when the tab goes away.
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
    setPreview(next);
  };
  const closePreview = () => {
    previewRef.current?.file.dispose();
    show(null);
  };
  const say = (path: string, message: string) =>
    setMessages((current) => ({ ...current, [path]: message }));
  const open = async (file: ChannelBotArtifact) => {
    const signal = lifetime.current?.signal;
    if (environmentId === null || signal === undefined || signal.aborted) return;
    const name = botArtifactName(file.relativePath);
    setOpening(file.relativePath);
    setMessages(({ [file.relativePath]: _old, ...rest }) => rest);
    try {
      const result = await readWholeBotArtifact(
        file.relativePath,
        async (input: ChannelReadBotArtifactInput) => {
          const answer = await runAtomCommand(
            appAtomRegistry,
            channelEnvironment.readBotArtifact,
            { environmentId, input },
            { label: "GOAT Bot Library file", reportFailure: false },
          );
          if (answer._tag === "Failure") throw squashAtomCommandFailure(answer);
          return answer.value;
        },
        signal,
      );
      if (signal.aborted) return;
      if (result.status !== "ok") {
        say(file.relativePath, botArtifactOpenMessage(name, result));
        return;
      }
      const attachment = { name, mimeType: result.mimeType };
      // Loaded on open: its file and crypto modules are native and the tab may never open a file.
      const { shareGeneratedAttachment, writeGeneratedAttachmentFile } =
        await import("../../lib/attachmentDownload");
      if (signal.aborted) return;
      if (result.mimeType.startsWith("image/")) {
        const cached = await writeGeneratedAttachmentFile({ bytes: result.bytes, attachment });
        if (signal.aborted) {
          cached.dispose();
          return;
        }
        show({ name, file: cached });
        return;
      }
      const shared = await shareGeneratedAttachment({ bytes: result.bytes, attachment, signal });
      if (!shared && !signal.aborted)
        say(file.relativePath, "Sharing isn't available on this device.");
    } catch (error) {
      if (signal.aborted) return;
      say(
        file.relativePath,
        error instanceof Error && error.message === "Could not open the share sheet. Try again."
          ? error.message
          : botArtifactsFailure(error).message,
      );
    } finally {
      if (!signal.aborted) setOpening(null);
    }
  };
  if (!connected)
    return (
      <Text className="text-foreground-muted">
        Files are unavailable while GOAT Bot is offline.
      </Text>
    );
  if (!supported)
    return <Text className="text-foreground-muted">Files need a newer GOAT server.</Text>;
  const failure = files.cause === null ? null : botArtifactsFailure(files.cause);
  if (failure !== null)
    return (
      <View className="gap-1">
        <Text className="text-danger-foreground">{failure.message}</Text>
        {failure.retry ? (
          <Pressable
            accessibilityRole="button"
            onPress={refresh}
            className="min-h-[44px] min-w-[44px] justify-center px-2"
          >
            <Text className="text-foreground">Try again</Text>
          </Pressable>
        ) : null}
      </View>
    );
  if (files.data === null) return <Text className="text-foreground-muted">Loading files…</Text>;
  if (files.data.artifacts.length === 0)
    return <Text className="text-foreground-muted">Files GOAT Bot saves will appear here.</Text>;
  return (
    <View className="gap-1 py-2">
      {files.data.truncated ? (
        <Text className="text-foreground-muted">Showing the newest files only.</Text>
      ) : null}
      {files.data.artifacts.map((file) => {
        const name = botArtifactName(file.relativePath);
        const folder = file.relativePath.slice(0, -name.length).replace(/\/$/, "");
        return (
          <View key={file.relativePath} className="border-b border-border py-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${name}`}
              disabled={opening !== null}
              onPress={() => void open(file)}
              className="min-h-[44px] justify-center"
            >
              <Text className="text-foreground">{name}</Text>
              <Text className="text-foreground-muted">
                {[
                  folder,
                  botArtifactSizeLabel(file.size),
                  opening === file.relativePath ? "Opening…" : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </Pressable>
            {messages[file.relativePath] ? (
              <Text className="text-danger-foreground">{messages[file.relativePath]}</Text>
            ) : null}
          </View>
        );
      })}
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
                if (preview && signal) void preview.file.share(signal).catch(() => {});
              }}
              className="min-h-[44px] min-w-[44px] justify-center px-2"
            >
              <Text className="text-foreground">Share</Text>
            </Pressable>
          </View>
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
    </View>
  );
}
