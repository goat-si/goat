import {
  goatBotRowPullRequests,
  type GoatBotRowPullRequestChip,
} from "@goat/client-runtime/goatBot";
import type { BotThreadRow } from "@goat/contracts";
import { Pressable, Text, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { mobileBotTaskStatus, type MobileTaskChips } from "./mobileBotTaskStatus";
import { mobileRowTimeSpoken, useMobileRowTime } from "./useMobileRowTime";

type TaskRow = Extract<BotThreadRow, { kind: "task" }>;
type Section = "running" | "waiting" | "finished";

/** Pull request chips a row shows; the rest are counted. Web shows the same number. */
const VISIBLE_PULL_REQUESTS = 2;
const CHIP_TEXT_CLASS: Record<GoatBotRowPullRequestChip["state"], string> = {
  open: "text-pr-open",
  merged: "text-pr-merged",
  closed: "text-pr-closed",
  unknown: "text-foreground-muted",
};

/**
 * The words a task row says and VoiceOver reads: title, status, how long ago, unread and pinned,
 * then each pull request shown and how many more there are.
 */
export function mobileBotTaskLabel(row: TaskRow, chips: MobileTaskChips, time = ""): string {
  const spoken = mobileRowTimeSpoken(time);
  const pullRequests = goatBotRowPullRequests(row, VISIBLE_PULL_REQUESTS);
  return [
    row.task.title,
    mobileBotTaskStatus(row, chips),
    ...(spoken ? [spoken] : []),
    ...(row.unread ? ["unread"] : []),
    ...(row.view.pinnedAt ? ["pinned"] : []),
    ...pullRequests.chips.map((chip) => chip.accessibleName),
    ...(pullRequests.more > 0
      ? [`${pullRequests.more} more pull request${pullRequests.more === 1 ? "" : "s"}`]
      : []),
  ].join(", ");
}

/**
 * A Home work row's opening control. Its pull requests are words inside the control, not links:
 * the row opens as before, and the links stay in the task and its threads.
 */
export function MobileBotWorkRow(props: {
  readonly row: TaskRow;
  readonly section: Section;
  readonly chips: MobileTaskChips;
  /** Home is shown and the app active; otherwise the time does not follow the clock. */
  readonly ticking: boolean;
  readonly openable: boolean;
  readonly actions: ReadonlyArray<{ readonly name: string; readonly label: string }>;
  readonly onAction: (name: string) => void;
  readonly onPress: () => void;
  /** Set by the row menu on Android, where a long press opens the row's actions. */
  readonly onLongPress?: () => void;
}) {
  const { row, section } = props;
  const time = useMobileRowTime(row.lastActivityAt, props.ticking);
  const pullRequests = goatBotRowPullRequests(row, VISIBLE_PULL_REQUESTS);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={mobileBotTaskLabel(row, props.chips, time)}
      accessibilityActions={props.actions}
      onAccessibilityAction={(event) => props.onAction(event.nativeEvent.actionName)}
      accessibilityState={{ disabled: !props.openable }}
      disabled={!props.openable}
      className="min-h-[44px] flex-1 flex-row items-center gap-2"
      onPress={props.onPress}
      {...(props.onLongPress ? { onLongPress: props.onLongPress } : {})}
    >
      {section === "running" ? (
        <View className="h-2 w-2 rounded-full bg-adaptive-blue-500-400" />
      ) : (
        <SymbolView
          name={section === "waiting" ? "questionmark.bubble" : "checkmark"}
          size={14}
          tintColorClassName={
            section === "waiting" ? "accent-warning-foreground" : "accent-foreground-muted"
          }
        />
      )}
      <View className="flex-1">
        <Text className="text-foreground">{row.task.title}</Text>
        <View className="flex-row items-center gap-1">
          {row.view.pinnedAt ? (
            <SymbolView name="pin" size={12} tintColorClassName="accent-foreground-muted" />
          ) : null}
          {row.unread ? (
            <View
              accessibilityElementsHidden
              className="h-2 w-2 rounded-full bg-adaptive-blue-500-400"
            />
          ) : null}
          <Text className="text-xs text-foreground-muted">
            {mobileBotTaskStatus(row, props.chips)}
            {time ? ` · ${time}` : ""}
            {row.unread ? " · Unread" : ""}
          </Text>
        </View>
        {pullRequests.chips.length > 0 || pullRequests.moreLabel ? (
          // The name above already says each pull request; these words are for the eye.
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className="flex-row flex-wrap items-center gap-x-2"
          >
            {pullRequests.chips.map((chip) => (
              <Text key={chip.key} className={`text-xs ${CHIP_TEXT_CLASS[chip.state]}`}>
                {chip.state === "unknown" ? chip.text : `${chip.text} ${chip.stateLabel}`}
              </Text>
            ))}
            {pullRequests.moreLabel ? (
              <Text className="text-xs text-foreground-muted">{pullRequests.moreLabel}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
      <SymbolView name="chevron.right" size={14} tintColorClassName="accent-foreground-muted" />
    </Pressable>
  );
}
