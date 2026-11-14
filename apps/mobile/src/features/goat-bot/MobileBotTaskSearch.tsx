import type { BotId, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { lookedUpTitle } from "./lookedUpTitle";
import { useMobileBotTaskSearch, type MobileTaskSearchState } from "./useMobileBotTaskSearch";
import { useMobileStatusAnnouncement } from "./useMobileStatusAnnouncement";

const TOO_LONG = "Search text is too long for task titles.";
const NONE = "No matching tasks.";
const PARTIAL = "Some results could not be checked.";
const CAPPED = "More tasks may exist. Narrow your search.";
const ENDED = "Search ended early.";

/** A search says nothing matched only when it is complete. */
const complete = (value: MobileTaskSearchState) =>
  !value.partial && !value.endedEarly && value.cursor === undefined;

/** What the field's status says now, as one line; silent while a page is read. */
function statusLine(tooLong: boolean, value: MobileTaskSearchState | null) {
  if (tooLong) return TOO_LONG;
  if (value === null || value.loading) return null;
  if (value.failed) return "Couldn't search tasks.";
  const lines = [
    complete(value) && value.tasks.length === 0 ? NONE : null,
    value.partial ? PARTIAL : null,
    value.capped ? CAPPED : value.endedEarly ? ENDED : null,
  ].filter((line) => line !== null);
  return lines.length > 0 ? lines.join(" ") : null;
}

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
  useMobileStatusAnnouncement(statusLine(search.tooLong, search.query === null ? null : value));
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
      {search.tooLong ? <Text className="text-foreground-muted">{TOO_LONG}</Text> : null}
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
              className="min-h-[44px] min-w-[44px] justify-center"
            >
              <Text className="text-danger-foreground">Couldn't search tasks. Try again</Text>
            </Pressable>
          ) : value.tasks.length === 0 && complete(value) ? (
            <Text className="text-foreground-muted">{NONE}</Text>
          ) : null}
          {value.partial ? <Text className="text-foreground-muted">{PARTIAL}</Text> : null}
          {value.capped ? (
            <Text className="text-foreground-muted">{CAPPED}</Text>
          ) : value.endedEarly ? (
            <Text className="text-foreground-muted">{ENDED}</Text>
          ) : value.cursor !== undefined && !value.loading && !value.failed ? (
            <Pressable
              accessibilityRole="button"
              onPress={search.loadMore}
              className="min-h-[44px] min-w-[44px] justify-center"
            >
              <Text className="text-foreground">Load more</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}
