import type { BotId, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { lookedUpTitle } from "./lookedUpTitle";
import { useMobileBotTaskSearch } from "./useMobileBotTaskSearch";

/**
 * Finds one bot's tasks by title on a server that can (`goatBotTaskLookupSearch`). Its owner
 * mounts it only while that computer is connected and says so; unmounting drops any answer.
 */
export function MobileBotTaskSearch(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly botName: string;
  readonly onOpenTask: (id: ChannelTaskId, title: string) => void;
}) {
  const [text, setText] = useState("");
  const search = useMobileBotTaskSearch({
    environmentId: props.environmentId,
    botId: props.botId,
    text,
  });
  const value = search.value;
  return (
    <View className="gap-1 pb-2">
      <TextInput
        accessibilityLabel={`Search ${props.botName}'s tasks`}
        placeholder="Search tasks"
        value={text}
        onChangeText={setText}
        maxLength={256}
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
        className="min-h-[44px] rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
      />
      {search.query === null || value === null ? null : (
        <>
          {value.tasks.map((task) => (
            <Pressable
              key={task.taskId}
              accessibilityRole="button"
              onPress={() => props.onOpenTask(task.taskId, task.title)}
              className="min-h-[44px] justify-center"
            >
              <Text numberOfLines={1} className="text-foreground">
                {lookedUpTitle(task.title, task.titleTruncated)}
              </Text>
            </Pressable>
          ))}
          {value.loading ? (
            <Text className="text-foreground-muted">Searching…</Text>
          ) : value.failed ? (
            <Pressable
              accessibilityRole="button"
              onPress={search.retry}
              className="min-h-[44px] justify-center"
            >
              <Text className="text-danger-foreground">Couldn't search tasks. Try again</Text>
            </Pressable>
          ) : value.tasks.length === 0 && value.cursor === undefined && !value.endedEarly ? (
            <Text className="text-foreground-muted">No matching tasks.</Text>
          ) : null}
          {value.partial ? (
            <Text className="text-foreground-muted">
              Some tasks that might match could not be checked or shown.
            </Text>
          ) : null}
          {value.endedEarly ? (
            <Text className="text-foreground-muted">Search stopped early.</Text>
          ) : value.cursor !== undefined && !value.loading && !value.failed ? (
            <Pressable
              accessibilityRole="button"
              onPress={search.loadMore}
              className="min-h-[44px] justify-center"
            >
              <Text className="text-foreground">Load more</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}
