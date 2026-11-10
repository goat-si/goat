import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { goatBotUnreadMark } from "./goatBotUnread";
import type { GoatBotVisitSnapshot } from "./useGoatBotVisitSnapshot";

/** The "New" line in the conversation, a list item of its own so the list can tell where it is. */
export interface GoatBotUnreadDivider {
  readonly kind: "unread";
  readonly id: "unread-divider";
  readonly count: number;
}
export type GoatBotChatItem = GoatBotRow | GoatBotUnreadDivider;

const newMessages = (count: number) => `${count} new message${count === 1 ? "" : "s"}`;

/**
 * The conversation with the "New" divider before what the bot said since the person last read it,
 * and whether the pill pointing up to it shows. Both last until the person sends a message.
 */
export function useGoatBotUnread(
  rows: ReadonlyArray<GoatBotRow>,
  snapshot: GoatBotVisitSnapshot | null | undefined,
) {
  const visit = snapshot?.key ?? null;
  const [cleared, setCleared] = useState<string | null>(null);
  const [settled, setSettled] = useState<string | null>(null);
  const [above, setAbove] = useState(false);
  // Taken once per visit, when the conversation has loaded: replies that arrive while the person
  // is in the chat are read as they come and never move the line.
  const [frozen, setFrozen] = useState<{
    readonly visit: string;
    readonly mark: ReturnType<typeof goatBotUnreadMark>;
  } | null>(null);
  if (snapshot && visit !== null && frozen?.visit !== visit && rows.length > 0) {
    setFrozen({ visit, mark: goatBotUnreadMark(rows, snapshot.readUpTo) });
  }
  const mark = frozen !== null && frozen.visit === visit && cleared !== visit ? frozen.mark : null;
  const items = useMemo((): ReadonlyArray<GoatBotChatItem> => {
    const at = mark === null ? -1 : rows.findIndex((row) => row.id === mark.firstId);
    if (mark === null || at < 0) return rows;
    const divider: GoatBotUnreadDivider = {
      kind: "unread",
      id: "unread-divider",
      count: mark.count,
    };
    return [...rows.slice(0, at), divider, ...rows.slice(at)];
  }, [rows, mark]);
  const dividerIndex = mark === null ? -1 : items.findIndex((item) => item.kind === "unread");
  /** Called with the list's viewable indexes; the divider is above when it lies before them. */
  const onViewable = useCallback(
    (indexes: ReadonlyArray<number>) => {
      if (dividerIndex < 0 || indexes.length === 0) return;
      if (indexes.includes(dividerIndex)) {
        setAbove(false);
        setSettled(visit);
      } else setAbove(dividerIndex < Math.min(...indexes));
    },
    [dividerIndex, visit],
  );
  /** The pill was used or dismissed: it stays away this visit. */
  const settle = useCallback(() => setSettled(visit), [visit]);
  /** The person sent a message: they have caught up. */
  const clear = useCallback(() => setCleared(visit), [visit]);
  return {
    items,
    dividerIndex,
    /** The pill: unread above the screen, not yet seen or dismissed this visit. */
    pill: mark !== null && above && settled !== visit ? mark.count : null,
    onViewable,
    settle,
    clear,
  };
}

export function GoatBotUnreadDividerRow() {
  const label = useScaledTextRole("label");
  return (
    <View accessible accessibilityLabel="New messages" className="my-3 flex-row items-center gap-2">
      <View className="h-px flex-1 bg-border" />
      <Text className="text-foreground-muted" style={label}>
        New
      </Text>
      <View className="h-px flex-1 bg-border" />
    </View>
  );
}

/** Floats at the top of the conversation while what the bot said since the last read is above. */
export function GoatBotUnreadPill(props: {
  readonly count: number;
  readonly onPress: () => void;
  readonly onDismiss: () => void;
}) {
  const label = useScaledTextRole("label");
  return (
    <View pointerEvents="box-none" className="items-center" style={{ paddingTop: 8 }}>
      <View className="flex-row items-center rounded-full border border-border bg-screen">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${newMessages(props.count)}, scrolls to the first`}
          onPress={props.onPress}
          className="min-h-[44px] flex-row items-center gap-1.5 pl-4 pr-2"
        >
          <SymbolView name="arrow.up" size={12} tintColorClassName="accent-icon" />
          <Text className="text-foreground" style={label}>
            {newMessages(props.count)}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hide new messages"
          onPress={props.onDismiss}
          className="min-h-[44px] min-w-[44px] items-center justify-center"
        >
          <SymbolView name="xmark" size={11} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </View>
    </View>
  );
}
