import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import type { ComponentProps, ReactNode } from "react";
import { Pressable, View } from "react-native";
import { THREAD_WORK_ROW_MIN_HEIGHT, type deriveThreadWorkLogSizing } from "../../lib/layout";

const ROW_SIDE_SLOP = 4;
/**
 * Rows that open and close work stand next to other tappable rows, where vertical hit slop
 * steals their taps, so they take a real 44pt height with the content centred.
 */
export const EXPANDABLE_ROW_MIN_HEIGHT = 44;
const EXPANDABLE_ROW_HIT_SLOP = { left: ROW_SIDE_SLOP, right: ROW_SIDE_SLOP } as const;

export function WorkLogBlock({
  children,
  layout = "standalone",
  continues = false,
}: {
  children: ReactNode;
  layout?: "standalone" | "group-header";
  continues?: boolean | undefined;
}) {
  return (
    <View className={continues || layout === "group-header" ? "-mx-1 px-1" : "-mx-1 mb-1 px-1"}>
      {children}
    </View>
  );
}

export function WorkLogRows({ children }: { children: ReactNode }) {
  return <View className="gap-px">{children}</View>;
}

export function WorkLogIconSlot({ children }: { children: ReactNode }) {
  return <View className="relative h-6 w-6 shrink-0 items-center justify-center">{children}</View>;
}

export function WorkLogPressable({
  children,
  rowSizing,
  expandable = false,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children" | "className" | "style" | "hitSlop"> & {
  children: ReactNode;
  rowSizing?: ReturnType<typeof deriveThreadWorkLogSizing>;
  /** Rows that open and close a group are 44pt tall; plain rows keep their height and a small slop. */
  expandable?: boolean;
}) {
  const contentHeight = rowSizing?.estimatedRowHeight ?? THREAD_WORK_ROW_MIN_HEIGHT;
  return (
    <Pressable
      {...props}
      hitSlop={expandable ? EXPANDABLE_ROW_HIT_SLOP : ROW_SIDE_SLOP}
      className="rounded-md px-0.5 py-0 active:bg-subtle"
    >
      <View
        className="flex-row items-center gap-1.5"
        style={{
          minHeight: expandable
            ? Math.max(EXPANDABLE_ROW_MIN_HEIGHT, contentHeight)
            : contentHeight,
        }}
      >
        {children}
      </View>
    </Pressable>
  );
}

export function WorkLogLabel({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "danger" | "warning";
}) {
  return (
    <Text
      selectable={false}
      numberOfLines={1}
      ellipsizeMode="tail"
      className={cn(
        "min-w-0 flex-1 text-sm text-foreground-muted",
        tone === "danger" && "font-goat-medium text-adaptive-rose-600-400",
        tone === "warning" && "font-goat-medium text-warning-foreground",
      )}
    >
      {children}
    </Text>
  );
}
