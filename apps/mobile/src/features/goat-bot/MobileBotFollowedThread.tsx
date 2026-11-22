import { scopeThreadRef } from "@goat/client-runtime/environment";
import { useQuietThreadShell } from "../../state/entities";
import { useAtomValue } from "@effect/atom-react";
import type { ReactNode } from "react";
import type { MobileBotHomeItem } from "./MobileBotTaskList";
import type {
  BotId,
  ChannelListFollowedThreadsResult,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import { Alert, Text, View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { channelEnvironment } from "../../state/channels";
import { useAtomCommand } from "../../state/use-atom-command";

function MobileBotFollowedThread({
  environmentId,
  botId,
  row,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly row: ChannelListFollowedThreadsResult["followedThreads"][number];
  readonly onOpen: (thread: { environmentId: EnvironmentId; id: ThreadId }) => void;
}) {
  const thread = useQuietThreadShell(scopeThreadRef(row.environmentId, row.threadId));
  const canStop = useAtomValue(
    channelEnvironment.stopFollowingThread.permissionAtom(environmentId),
  );
  const stop = useAtomCommand(channelEnvironment.stopFollowingThread);
  return (
    <View className="gap-1 px-2 py-2">
      <Button
        label={thread?.title ?? "Open followed thread"}
        onPress={() => onOpen({ environmentId: row.environmentId, id: row.threadId })}
      />
      {row.status && <AppText>{row.status}</AppText>}
      {row.pullRequest && <AppText>{row.pullRequest}</AppText>}
      {canStop && (
        <Button
          label="Stop following"
          onPress={async () => {
            const result = await stop({
              environmentId,
              input: { botId, environmentId: row.environmentId, threadId: row.threadId },
            });
            if (result._tag === "Failure") Alert.alert("Could not stop following this thread.");
          }}
        />
      )}
    </View>
  );
}

export const sectionLabel = (
  key: string,
  text: string,
  first = false,
  action?: ReactNode,
): MobileBotHomeItem => ({
  key,
  render: () => (
    <View className={`${first ? "mt-2" : "mt-5"} flex-row items-center justify-between`}>
      <Text className="text-xs font-medium text-foreground-muted">{text}</Text>
      {action}
    </View>
  ),
});

export function mobileBotFollowedItems(
  environmentId: EnvironmentId | null,
  botId: BotId,
  rows: ChannelListFollowedThreadsResult["followedThreads"] | undefined,
  onOpen: (thread: { environmentId: EnvironmentId; id: ThreadId }) => void,
): MobileBotHomeItem[] {
  if (!environmentId || !rows?.length) return [];
  return [
    sectionLabel("followed-threads", "Followed threads"),
    ...rows.map((row) => ({
      key: `follow:${row.threadId}`,
      render: () => (
        <MobileBotFollowedThread
          environmentId={environmentId}
          botId={botId}
          row={row}
          onOpen={onOpen}
        />
      ),
    })),
  ];
}
