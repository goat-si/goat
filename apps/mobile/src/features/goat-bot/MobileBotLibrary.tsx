import {
  botArtifactName,
  botArtifactSizeLabel,
  botArtifactsFailure,
  goatBotArtifactDays,
} from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { useNowMinuteMs } from "../../lib/clock";
import { channelEnvironment } from "../../state/channels";
import { useEnvironmentQuery } from "../../state/query";
import { useBotFileOpener } from "./MobileBotFileViewer";
import { MobileBotPanelEmpty } from "./MobileBotPanelEmpty";

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
  const nowMs = useNowMinuteMs();
  const { open, opening, messages, viewer } = useBotFileOpener(environmentId, botName);
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
      {viewer}
    </View>
  );
}
