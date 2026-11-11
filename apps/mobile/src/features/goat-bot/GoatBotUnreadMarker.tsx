import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Pressable,
  Text,
  View,
  findNodeHandle,
  type ViewInstance,
} from "react-native";

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
const NONE: ReadonlySet<string> = new Set();

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
  const [focusDivider, setFocusDivider] = useState(false);
  const [dividerShown, setDividerShown] = useState(false);
  // Rows marked in this visit, so a card that changes again stays marked where it was.
  const [kept, setKept] = useState<{ visit: string | null; ids: ReadonlySet<string> }>({
    visit: null,
    ids: NONE,
  });
  const keptIds = kept.visit === visit ? kept.ids : NONE;
  const mark = useMemo(
    () =>
      snapshot && cleared !== visit
        ? goatBotUnreadMark(rows, snapshot.readUpTo, snapshot.newestAtOpen, keptIds)
        : null,
    [rows, snapshot, cleared, visit, keptIds],
  );
  if (mark !== null && mark.ids.some((id) => !keptIds.has(id))) {
    setKept({ visit, ids: new Set([...keptIds, ...mark.ids]) });
  }
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
      setDividerShown(indexes.includes(dividerIndex));
      if (indexes.includes(dividerIndex)) {
        setAbove(false);
        setSettled(visit);
      } else setAbove(dividerIndex < Math.min(...indexes));
    },
    [dividerIndex, visit],
  );
  /** The pill was used or dismissed: it stays away this visit. */
  const settle = useCallback(() => setSettled(visit), [visit]);
  /** The pill was used: the list scrolls to the divider and VoiceOver follows it there. */
  const jump = useCallback(() => {
    setSettled(visit);
    setFocusDivider(true);
  }, [visit]);
  const dividerFocused = useCallback(() => setFocusDivider(false), []);
  /** The person sent a message: they have caught up. */
  const clear = useCallback(() => setCleared(visit), [visit]);
  return {
    items,
    dividerIndex,
    /** The pill: unread above the screen, not yet seen or dismissed this visit. */
    pill: mark !== null && above && settled !== visit ? mark.count : null,
    onViewable,
    settle,
    jump,
    /** The divider takes accessibility focus after a jump, once the list shows it. */
    focusDivider: focusDivider && dividerShown,
    dividerFocused,
    clear,
  };
}

export function GoatBotUnreadDividerRow(props: {
  readonly focus?: boolean;
  readonly onFocused?: () => void;
}) {
  const label = useScaledTextRole("label");
  const ref = useRef<ViewInstance>(null);
  const { focus, onFocused } = props;
  // oxlint-disable-next-line goat/react-effect-budget -- Move the screen reader to the divider once the list has rendered it after a jump.
  useEffect(() => {
    if (!focus) return;
    const node = findNodeHandle(ref.current);
    if (node === null || node === undefined) return;
    AccessibilityInfo.setAccessibilityFocus(node);
    onFocused?.();
  }, [focus, onFocused]);
  return (
    <View
      ref={ref}
      accessible
      accessibilityLabel="New messages"
      className="my-3 flex-row items-center gap-2"
    >
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
