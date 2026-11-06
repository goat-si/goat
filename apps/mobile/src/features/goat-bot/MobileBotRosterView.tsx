import type { ReactNode } from "react";
import type { BotRosterEntry } from "@goat/client-runtime/goatBot";
import { botThreadKey, presentTaskStatus } from "@goat/client-runtime/goatBot";
import type { BotThreadRow } from "@goat/contracts";
import { Pressable, ScrollView, Text, View } from "react-native";
import { GoatWordmark } from "../../components/GoatWordmark";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { MOBILE_CHROME_MAX_FONT_SCALE } from "../../lib/typography";

/** New bot is disabled until bots can be created. */
const ignorePress = () => undefined;
import { DONE_STATUS_LABEL, STATUS_LABEL_BY_STATUS } from "../threads/thread-list-v2-row-meta";
import type { ThreadListV2Status } from "../threads/threadListV2";
import type { MobileHomeMode } from "./goatBotHomeMode";

export function MobileHomeSegments(props: {
  mode: MobileHomeMode;
  onSelect: (mode: MobileHomeMode) => void;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const dark = themeAppearance === "dark";
  return (
    <View
      className={
        dark
          ? "mx-4 my-2 flex-row rounded-lg bg-card p-1"
          : "mx-4 my-2 flex-row rounded-lg bg-grouped-card p-1"
      }
    >
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
              ? dark
                ? "min-h-[44px] flex-1 items-center justify-center rounded-md bg-grouped-card px-3 py-2"
                : "min-h-[44px] flex-1 items-center justify-center rounded-md bg-card px-3 py-2"
              : "min-h-[44px] flex-1 items-center justify-center rounded-md px-3 py-2"
          }
        >
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={MOBILE_CHROME_MAX_FONT_SCALE}
            className="text-sm font-semibold text-foreground"
          >
            {label}
          </Text>
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
  selectedKey?: string | null;
  codingStatuses?: ReadonlyMap<string, ThreadListV2Status | "done">;
  expanded?: boolean;
  hiddenCount?: number;
  slackEnabled: boolean;
  preview?: string;
  unread?: boolean;
  onOpenBot: (bot: BotRosterEntry) => void;
  onOpenChild: (row: BotThreadRow) => void;
  onTaskAction?: (
    row: Extract<BotThreadRow, { kind: "task" }>,
    action: "pin" | "done" | "read",
  ) => void;
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
            accessibilityState={{ selected: bot.kind === "main" && props.selectedKey === "main" }}
            accessibilityLabel={`${bot.profile?.name ?? "GOAT Bot"}${bot.kind === "main" && props.unread ? ", unread" : ""}`}
            className={
              bot.kind === "main" && props.selectedKey === "main"
                ? "flex-row items-center gap-3 bg-thread-selected px-4 py-3"
                : "flex-row items-center gap-3 px-4 py-3"
            }
          >
            <View className="h-10 w-10 items-center justify-center rounded-full bg-grouped-card">
              {bot.kind === "main" ? (
                <GoatWordmark height={20} colorClassName="accent-icon" />
              ) : (
                <Text className="text-lg text-foreground">
                  {(bot.profile?.name ?? "GOAT Bot").slice(0, 1)}
                </Text>
              )}
            </View>
            <View className="min-w-0 flex-1">
              <Text className="font-semibold text-foreground">
                {bot.profile?.name ?? "GOAT Bot"}
                {bot.kind === "main" ? "  ·  Main" : ""}
                {bot.kind === "main" && props.slackEnabled ? "  ·  Slack" : ""}
              </Text>
              {bot.kind === "main" && props.unread ? (
                <View className="flex-row items-center gap-1">
                  <View
                    accessibilityElementsHidden
                    className="h-2 w-2 rounded-full bg-adaptive-blue-500-400"
                  />
                  <Text className="text-xs text-foreground-muted">Unread</Text>
                </View>
              ) : null}
              {bot.kind === "main" && props.preview ? (
                <Text numberOfLines={1} className="text-foreground-muted">
                  {props.preview}
                </Text>
              ) : null}
            </View>
          </Pressable>
          {bot.kind === "main"
            ? props.rows.map((row) => {
                const codingStatus =
                  row.kind === "coding" ? props.codingStatuses?.get(botThreadKey(row)) : undefined;
                const marker =
                  codingStatus === "done"
                    ? DONE_STATUS_LABEL
                    : codingStatus
                      ? STATUS_LABEL_BY_STATUS[codingStatus]
                      : undefined;
                return (
                  <Pressable
                    key={botThreadKey(row)}
                    accessibilityRole="button"
                    onPress={() => props.onOpenChild(row)}
                    onLongPress={row.kind === "task" ? () => props.onLongPressTask(row) : undefined}
                    accessibilityState={{ selected: props.selectedKey === botThreadKey(row) }}
                    accessibilityLabel={
                      row.kind === "task"
                        ? `${row.task.title}, ${presentTaskStatus(row.task.status, row.view.doneAt).label}${row.unread ? ", unread" : ""}${row.view.pinnedAt ? ", pinned" : ""}`
                        : `${row.title || "GOAT thread"}${marker ? `, ${marker.label}` : ""}`
                    }
                    accessibilityActions={
                      row.kind === "task"
                        ? [
                            { name: "pin", label: row.view.pinnedAt ? "Unpin" : "Pin" },
                            { name: "done", label: row.view.doneAt ? "Reopen" : "Mark done" },
                            { name: "read", label: "Mark read" },
                          ]
                        : undefined
                    }
                    onAccessibilityAction={
                      row.kind === "task"
                        ? (event) => {
                            const action = event.nativeEvent.actionName;
                            if (action === "pin" || action === "done" || action === "read")
                              props.onTaskAction?.(row, action);
                          }
                        : undefined
                    }
                    className={
                      props.selectedKey === botThreadKey(row)
                        ? "ml-10 min-h-[44px] bg-thread-selected px-4 py-3"
                        : "ml-10 min-h-[44px] px-4 py-3"
                    }
                  >
                    <Text numberOfLines={1} className="text-foreground">
                      {row.kind === "task" ? row.task.title : row.title || "GOAT thread"}
                    </Text>
                    <View className="flex-row items-center gap-1">
                      {row.kind === "task" && row.view.pinnedAt ? (
                        <SymbolView
                          name="pin"
                          size={12}
                          tintColorClassName="accent-foreground-muted"
                        />
                      ) : null}
                      {row.kind === "task" && row.unread ? (
                        <View
                          accessibilityElementsHidden
                          className="h-2 w-2 rounded-full bg-adaptive-blue-500-400"
                        />
                      ) : null}
                      {marker ? (
                        <SymbolView
                          name={marker.icon}
                          size={12}
                          tintColorClassName={marker.iconTintClassName}
                        />
                      ) : null}
                      <Text className={marker?.className ?? "text-xs text-foreground-muted"}>
                        {row.kind === "task"
                          ? `${presentTaskStatus(row.task.status, row.view.doneAt).label}${row.unread ? " · Unread" : ""}`
                          : (marker?.label ?? "GOAT thread")}
                      </Text>
                    </View>
                  </Pressable>
                );
              })
            : null}
          {bot.kind === "main" && props.rows.length === 0 ? (
            <Text className="ml-10 px-4 py-3 text-foreground-muted">
              Work GOAT Bot starts will appear here.
            </Text>
          ) : null}
          {bot.kind === "main" &&
          (props.hasMore || props.expanded) &&
          (props.hiddenCount ?? 0) > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={props.onShowMore}
              accessibilityState={{ expanded: props.expanded === true }}
              className="ml-10 px-4 py-3"
            >
              <Text className="text-foreground">
                {props.expanded ? "Show less" : `Show more (${props.hiddenCount})`}
              </Text>
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
