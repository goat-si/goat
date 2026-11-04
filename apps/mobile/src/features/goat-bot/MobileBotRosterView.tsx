import type { ReactNode } from "react";
import type { BotRosterEntry } from "@goat/client-runtime/goatBot";
import { botThreadKey } from "@goat/client-runtime/goatBot";
import type { BotThreadRow } from "@goat/contracts";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Button } from "../../components/ui/Button";

/** New bot is disabled until bots can be created. */
const ignorePress = () => undefined;
import type { MobileHomeMode } from "./goatBotHomeMode";

export function MobileHomeSegments(props: {
  mode: MobileHomeMode;
  onSelect: (mode: MobileHomeMode) => void;
}) {
  return (
    <View className="mx-4 my-2 flex-row rounded-lg bg-grouped-card p-1">
      {(
        [
          ["bot", "Bots"],
          ["thread", "Threads"],
        ] as const
      ).map(([mode, label]) => (
        <Pressable
          key={mode}
          accessibilityRole="button"
          accessibilityState={{ selected: props.mode === mode }}
          onPress={() => props.onSelect(mode)}
          className={
            mode === props.mode
              ? "min-h-[44px] flex-1 items-center justify-center rounded-md bg-card px-3 py-2"
              : "min-h-[44px] flex-1 items-center justify-center rounded-md px-3 py-2"
          }
        >
          <Text className="text-sm font-semibold text-foreground">{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function MobileBotRosterView(props: {
  header?: ReactNode;
  bots: ReadonlyArray<BotRosterEntry>;
  rows: ReadonlyArray<BotThreadRow>;
  hasMore: boolean;
  slackEnabled: boolean;
  preview?: string;
  unread?: boolean;
  onOpenBot: (bot: BotRosterEntry) => void;
  onOpenChild: (row: BotThreadRow) => void;
  onLongPressTask: (row: Extract<BotThreadRow, { kind: "task" }>) => void;
  onShowMore: () => void;
}) {
  return (
    <ScrollView className="flex-1 bg-screen" contentInsetAdjustmentBehavior="automatic">
      {props.header}
      {props.bots.map((bot) => (
        <View key={bot.profile?.botId ?? "main"}>
          <Pressable
            accessibilityRole="button"
            onPress={() => props.onOpenBot(bot)}
            className="flex-row items-center gap-3 px-4 py-3"
          >
            <View className="h-10 w-10 items-center justify-center rounded-full bg-grouped-card">
              <Text className="text-lg text-foreground">
                {(bot.profile?.name ?? "GOAT Bot").slice(0, 1)}
              </Text>
            </View>
            <View className="min-w-0 flex-1">
              <Text className="font-semibold text-foreground">
                {bot.profile?.name ?? "GOAT Bot"}
                {bot.kind === "main" ? "  ·  Main" : ""}
                {bot.kind === "main" && props.slackEnabled ? "  ·  Slack" : ""}
                {bot.kind === "main" && props.unread ? "  •" : ""}
              </Text>
              {bot.kind === "main" && props.preview ? (
                <Text numberOfLines={1} className="text-foreground-muted">
                  {props.preview}
                </Text>
              ) : null}
            </View>
          </Pressable>
          {bot.kind === "main"
            ? props.rows.map((row) => (
                <Pressable
                  key={botThreadKey(row)}
                  accessibilityRole="button"
                  onPress={() => props.onOpenChild(row)}
                  onLongPress={row.kind === "task" ? () => props.onLongPressTask(row) : undefined}
                  className="ml-10 px-4 py-3"
                >
                  <Text numberOfLines={1} className="text-foreground">
                    {row.kind === "task" ? row.task.title : row.title || "GOAT thread"}
                    {row.kind === "task" && row.unread ? "  •" : ""}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {row.kind === "task" ? row.task.status.replaceAll("_", " ") : "GOAT thread"}
                  </Text>
                </Pressable>
              ))
            : null}
          {bot.kind === "main" && props.hasMore ? (
            <Pressable
              accessibilityRole="button"
              onPress={props.onShowMore}
              className="ml-10 px-4 py-3"
            >
              <Text className="text-foreground">Show more</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      <View className="px-4 py-3">
        <Button
          label="New bot · Coming soon"
          icon="plus"
          disabled
          fullWidth
          accessibilityHint="Creating more bots is coming soon."
          onPress={ignorePress}
        />
      </View>
    </ScrollView>
  );
}
