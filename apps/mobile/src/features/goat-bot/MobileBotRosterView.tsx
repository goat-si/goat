import { useRef, useState, type ReactNode } from "react";
import type { BotRosterEntry } from "@goat/client-runtime/goatBot";
import {
  FACE_MOTION_RANK,
  botThreadKey,
  goatBotFaceLabel,
  presentTaskStatus,
} from "@goat/client-runtime/goatBot";
import type { BotProfile, BotThreadRow } from "@goat/contracts";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
  type ViewInstance,
} from "react-native";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { MOBILE_CHROME_MAX_FONT_SCALE } from "../../lib/typography";
import { GoatBotFaceAvatar } from "./GoatBotFace";
import { useMobileGoatBotFace, useMobileGoatBotFaceMotion } from "./useMobileGoatBotFace";

/** Servers without member bots keep New bot disabled. */
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
  /** Member bots: shown ones are in `bots`; these two lists carry the reverse states. */
  members?: {
    readonly hidden: ReadonlyArray<BotProfile>;
    readonly deleted: ReadonlyArray<BotProfile>;
    readonly canCreate: boolean;
    readonly onNewBot: () => void;
    /** Edit, hide, show, delete or restore; the panel asks what to do. */
    readonly onLongPressBot: (bot: BotRosterEntry) => void;
    readonly onPressDeleted: (bot: BotProfile) => void;
  };
}) {
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const mainFace = useMobileGoatBotFace(null);
  const mainFaceLabel = goatBotFaceLabel(mainFace.state);
  const { scrollRef, rowRef, onScreen, measure, hold, settle, measureUnlessCoasting } =
    useRowOnScreen();
  const mainMotion = useMobileGoatBotFaceMotion(
    mainFace.state,
    FACE_MOTION_RANK.list,
    mainFace.since,
    onScreen,
  );
  return (
    <ScrollView
      ref={scrollRef}
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      onLayout={measure}
      onScrollBeginDrag={hold}
      onMomentumScrollBegin={hold}
      onScrollEndDrag={measureUnlessCoasting}
      onMomentumScrollEnd={settle}
    >
      {props.header}
      {props.bots.map((bot) => (
        <View key={bot.profile?.botId ?? "main"}>
          <Pressable
            ref={bot.kind === "main" ? rowRef : undefined}
            onLayout={bot.kind === "main" ? measure : undefined}
            accessibilityRole="button"
            onPress={() => props.onOpenBot(bot)}
            onLongPress={props.members ? () => props.members?.onLongPressBot(bot) : undefined}
            accessibilityState={{
              selected:
                props.selectedKey === (bot.kind === "main" ? "main" : `bot:${bot.profile.botId}`),
            }}
            accessibilityLabel={`${bot.profile?.name ?? "GOAT Bot"}${bot.kind === "main" && mainFaceLabel ? `, ${mainFaceLabel}` : ""}${bot.kind === "main" && props.unread ? ", unread" : ""}`}
            className={
              props.selectedKey === (bot.kind === "main" ? "main" : `bot:${bot.profile.botId}`)
                ? "flex-row items-center gap-3 bg-thread-selected px-4 py-3"
                : "flex-row items-center gap-3 px-4 py-3"
            }
          >
            {bot.kind === "main" ? (
              <GoatBotFaceAvatar state={mainFace.state} size={40} motion={mainMotion} />
            ) : (
              <MemberFace bot={bot.profile} />
            )}
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
      {props.members && props.members.hidden.length > 0 ? (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: hiddenOpen }}
            onPress={() => setHiddenOpen((open) => !open)}
            className="min-h-[44px] justify-center px-4 py-3"
          >
            <Text className="text-foreground-muted">
              Hidden bots ({props.members.hidden.length})
            </Text>
          </Pressable>
          {hiddenOpen
            ? props.members.hidden.map((profile) => (
                <Pressable
                  key={profile.botId}
                  accessibilityRole="button"
                  accessibilityLabel={`${profile.name}, hidden`}
                  onPress={() => props.onOpenBot({ kind: "member", profile })}
                  onLongPress={() => props.members?.onLongPressBot({ kind: "member", profile })}
                  className="flex-row items-center gap-3 px-4 py-3"
                >
                  <MemberFace bot={profile} />
                  <Text className="text-foreground">{profile.name}</Text>
                </Pressable>
              ))
            : null}
        </View>
      ) : null}
      {props.members && props.members.deleted.length > 0 ? (
        <View>
          <Text accessibilityRole="header" className="px-4 pt-3 text-foreground-muted">
            Deleted bots
          </Text>
          {props.members.deleted.map((profile) => (
            <Pressable
              key={profile.botId}
              accessibilityRole="button"
              accessibilityLabel={`${profile.name}, deleted`}
              accessibilityHint="Restore this bot"
              onPress={() => props.members?.onPressDeleted(profile)}
              className="min-h-[44px] flex-row items-center justify-between px-4 py-3"
            >
              <Text className="text-foreground-muted">{profile.name}</Text>
              <Text className="text-foreground">Restore</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View className="px-4 py-3">
        {props.members ? (
          <Button
            label="New bot"
            icon="plus"
            disabled={!props.members.canCreate}
            fullWidth
            onPress={props.members.onNewBot}
          />
        ) : (
          <Button
            label="New bot · Coming soon"
            icon="plus"
            disabled
            fullWidth
            accessibilityHint="Creating more bots is coming soon."
            onPress={ignorePress}
          />
        )}
      </View>
    </ScrollView>
  );
}

/** A member's face from its own conversation; still, since only the main row and headers move. */
function MemberFace({ bot }: { readonly bot: BotProfile }) {
  const face = useMobileGoatBotFace(null, {
    environmentId: bot.environmentId,
    threadId: bot.sessionThreadId,
  });
  return <GoatBotFaceAvatar state={face.state} size={40} motion={null} />;
}

/**
 * Whether the main row is inside the roster's visible area, measured in window coordinates. False
 * until measured and from a scroll's start to its end; a generation drops any measurement that
 * lands after a scroll began, the layout changed or the roster unmounted.
 */
function useRowOnScreen() {
  const scrollNode = useRef<ScrollViewInstance | null>(null);
  const rowRef = useRef<ViewInstance>(null);
  const generation = useRef(0);
  const scrolling = useRef(false);
  const [onScreen, setOnScreen] = useState(false);
  const scrollRef = (node: ScrollViewInstance | null) => {
    scrollNode.current = node;
    return () => {
      scrollNode.current = null;
      generation.current += 1;
    };
  };
  const measure = () => {
    generation.current += 1;
    const pass = generation.current;
    const scroll = scrollNode.current;
    const row = rowRef.current;
    if (scrolling.current || scroll === null || row === null) return;
    scroll.measureInWindow((_scrollX, scrollTop, _scrollWidth, scrollHeight) => {
      row.measureInWindow((_rowX, rowTop, _rowWidth, rowHeight) => {
        if (pass !== generation.current || scrolling.current) return;
        setOnScreen(
          rowHeight > 0 &&
            scrollHeight > 0 &&
            rowTop + rowHeight > scrollTop &&
            rowTop < scrollTop + scrollHeight,
        );
      });
    });
  };
  const hold = () => {
    scrolling.current = true;
    generation.current += 1;
    setOnScreen(false);
  };
  const settle = () => {
    scrolling.current = false;
    measure();
  };
  // A drag released with speed coasts on; its momentum end measures instead.
  const measureUnlessCoasting = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const velocity = event.nativeEvent.velocity;
    if (velocity === undefined || (Math.abs(velocity.x) < 0.05 && Math.abs(velocity.y) < 0.05)) {
      settle();
    }
  };
  return { scrollRef, rowRef, onScreen, measure, hold, settle, measureUnlessCoasting };
}
