import type { LaunchChildState } from "@goat/client-runtime/state/launch-fold";
import { memo, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { THREAD_LIST_V2_SETTLED_PAGE_COUNT } from "./threadListV2";

/** How far each launch level indents its rows. */
export const LAUNCH_GROUP_INDENT = 16;

const DOT_CLASS = {
  working: "bg-adaptive-sky-600-400",
  attention: "bg-adaptive-amber-700-400",
  finished: "bg-adaptive-emerald-600-400",
} as const satisfies Record<LaunchChildState, string>;

function mutedText(pane: "screen" | "sidebar" | undefined) {
  return pane === "sidebar" ? "text-drawer-foreground-muted" : "text-foreground-muted";
}

/** A thread folded under its launcher, one indent deeper per level. */
export function ThreadListV2Nested(props: {
  readonly depth: number;
  readonly children: ReactNode;
}) {
  return props.depth > 0 ? (
    <View style={{ paddingLeft: props.depth * LAUNCH_GROUP_INDENT }}>{props.children}</View>
  ) : (
    props.children
  );
}

/**
 * Threads a row launched, folded to one thin line under it: their count, how many run and need
 * you, and a dot per thread. Expanded, they list as ordinary rows one indent deeper.
 */
export const ThreadListV2LaunchGroupRow = memo(function ThreadListV2LaunchGroupRow(props: {
  readonly parentKey: string;
  readonly depth: number;
  readonly label: string;
  readonly states: readonly LaunchChildState[];
  readonly expanded: boolean;
  readonly disabled?: boolean;
  readonly pane?: "screen" | "sidebar";
  readonly onToggle: (parentKey: string, expanded: boolean) => void;
}) {
  const sidebarPane = props.pane === "sidebar";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Launched threads: ${props.label}`}
      accessibilityHint={`${props.expanded ? "Collapses" : "Expands"} the threads this thread launched.`}
      accessibilityState={{ expanded: props.expanded, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={() => props.onToggle(props.parentKey, props.expanded)}
      className={cn("min-h-[30px] flex-row items-center gap-1.5", sidebarPane ? "pr-3" : "pr-5")}
      style={({ pressed }) => ({
        opacity: pressed ? 0.6 : 1,
        paddingLeft: (props.depth + 1) * LAUNCH_GROUP_INDENT + (sidebarPane ? 0 : 4),
      })}
    >
      <SymbolView
        name={props.expanded ? "chevron.down" : "chevron.right"}
        size={10}
        tintColorClassName={
          sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-muted"
        }
        type="monochrome"
      />
      <Text className={cn("shrink text-xs tabular-nums", mutedText(props.pane))} numberOfLines={1}>
        {props.label}
      </Text>
      <View className="ml-auto flex-row items-center gap-0.5 pl-1">
        {props.states.map((state, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- Dots have no identity beyond their position.
          <View key={index} className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASS[state])} />
        ))}
      </View>
    </Pressable>
  );
});

export const ThreadListV2LaunchMoreRow = memo(function ThreadListV2LaunchMoreRow(props: {
  readonly parentKey: string;
  readonly depth: number;
  readonly hidden: number;
  readonly pane?: "screen" | "sidebar";
  readonly onShowAll: (parentKey: string) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Show ${props.hidden} more launched threads`}
      onPress={() => props.onShowAll(props.parentKey)}
      className="min-h-[30px] flex-row items-center"
      style={({ pressed }) => ({
        opacity: pressed ? 0.6 : 1,
        paddingLeft: (props.depth + 1) * LAUNCH_GROUP_INDENT + 18,
      })}
    >
      <Text className={cn("text-xs", mutedText(props.pane))}>+{props.hidden} more</Text>
    </Pressable>
  );
});

export const ThreadListV2ShowMoreRow = memo(function ThreadListV2ShowMoreRow(props: {
  readonly pane?: "screen" | "sidebar";
  readonly hiddenCount: number;
  /** Older settled threads are loading, or their last read failed. */
  readonly state?: "loading" | "failed";
  readonly onPress: () => void;
}) {
  const label =
    props.state === "loading"
      ? "Loading"
      : props.state === "failed"
        ? "Could not load older threads. Retry"
        : `Show more (${props.hiddenCount} settled hidden)`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        props.state === undefined
          ? `Show ${Math.min(props.hiddenCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more settled threads`
          : label
      }
      disabled={props.state === "loading"}
      onPress={props.onPress}
      className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text
        className={
          props.pane === "sidebar"
            ? "text-xs font-goat-medium text-drawer-foreground-muted"
            : "text-xs font-goat-medium text-foreground-muted"
        }
      >
        {label}
      </Text>
    </Pressable>
  );
});
