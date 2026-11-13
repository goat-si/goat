import type { BotId, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { lookedUpTitle } from "./lookedUpTitle";
import { useMobileBotTaskSearch } from "./useMobileBotTaskSearch";

// Tasks of a routine share a title; when each started tells them apart.
const startedAt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const started = (createdAt: string) => {
  const at = Date.parse(createdAt);
  return Number.isNaN(at) ? null : `Started ${startedAt.format(at)}`;
};

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
      {search.tooLong ? (
        <Text className="text-foreground-muted">Search text is too long.</Text>
      ) : null}
      {search.query === null || value === null ? null : (
        <>
          {value.tasks.map((task) => {
            const title = lookedUpTitle(task.title, task.titleTruncated);
            const when = started(task.createdAt);
            return (
              <Pressable
                key={task.taskId}
                accessibilityRole="button"
                accessibilityLabel={when === null ? title : `${title}, ${when}`}
                onPress={() => props.onOpenTask(task.taskId, task.title)}
                className="min-h-[44px] justify-center py-1"
              >
                <Text numberOfLines={1} className="text-foreground">
                  {title}
                </Text>
                {when === null ? null : (
                  <Text numberOfLines={1} className="text-sm text-foreground-muted">
                    {when}
                  </Text>
                )}
              </Pressable>
            );
          })}
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
          {value.capped ? (
            <Text className="text-foreground-muted">Showing the first 50 matching tasks.</Text>
          ) : value.endedEarly ? (
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
