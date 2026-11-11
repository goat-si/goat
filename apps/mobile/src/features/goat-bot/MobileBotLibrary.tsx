import {
  botArtifactName,
  botArtifactSizeLabel,
  botArtifactsFailure,
  goatBotArtifactDays,
} from "@goat/client-runtime/goatBot";
import type { ChannelBotArtifact, EnvironmentId } from "@goat/contracts";
import { useEffect, useRef, useState } from "react";
import { Image, Modal, Pressable, Text, View } from "react-native";
import { useNowMinuteMs } from "../../lib/clock";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentQuery } from "../../state/query";
import { type ImagePreview, openBotLibraryFile } from "./openBotLibraryFile";
import { MobileBotPanelEmpty } from "./MobileBotPanelEmpty";

const withoutKey = (record: Readonly<Record<string, string>>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key));

/**
 * Files GOAT Bot's workers saved. An image opens here; other files go to the share sheet. A copy
 * handed to another app stays for it and is swept from the cache later; any other copy is deleted.
 */
export function MobileBotLibrary(props: {
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
  readonly supported: boolean;
  readonly botName?: string;
}) {
  const { environmentId, connected, supported } = props;
  const botName = props.botName ?? "GOAT Bot";
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
  const nowMs = useNowMinuteMs();
  const [messages, setMessages] = useState<Readonly<Record<string, string>>>({});
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
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
    setPreviewError(null);
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
    setOpening(file.relativePath);
    setMessages((current) => withoutKey(current, file.relativePath));
    const result = await openBotLibraryFile(environmentId, file.relativePath, signal, botName);
    if (signal.aborted) {
      if (result.kind === "image") result.preview.file.dispose();
      return;
    }
    setOpening(null);
    if (result.kind === "image") show(result.preview);
    else if (result.kind === "message") say(file.relativePath, result.message);
  };
  if (!connected)
    return (
      <Text className="text-foreground-muted">
        Files are unavailable while {botName} is offline.
      </Text>
    );
  if (!supported)
    return <Text className="text-foreground-muted">Files need a newer GOAT server.</Text>;
  const failure = files.cause === null ? null : botArtifactsFailure(files.cause, botName);
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
    return (
      <MobileBotPanelEmpty title="No files yet" next={`Files ${botName} saves will appear here.`} />
    );
  return (
    <View className="gap-1 py-2">
      {files.data.truncated ? (
        <Text className="text-foreground-muted">Showing the newest files only.</Text>
      ) : null}
      {goatBotArtifactDays(files.data.artifacts, nowMs).map((day) => (
        <View key={day.label} className="gap-1 pt-2">
          <Text accessibilityRole="header" className="text-xs font-medium text-foreground-muted">
            {day.label}
          </Text>
          {day.files.map((file) => {
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
        </View>
      ))}
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
    </View>
  );
}
