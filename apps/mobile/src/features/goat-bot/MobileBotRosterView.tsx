import { useRef, useState, type ReactNode } from "react";
import type { BotRosterEntry } from "@goat/client-runtime/goatBot";
import {
  FACE_MOTION_RANK,
  goatBotAvatarEmoji,
  goatBotFaceLabel,
  goatBotAccent,
} from "@goat/client-runtime/goatBot";
import type { BotProfile } from "@goat/contracts";
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
  type ViewInstance,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { Button } from "../../components/ui/Button";
import { MOBILE_CHROME_MAX_FONT_SCALE } from "../../lib/typography";
import { GoatBotFaceAvatar } from "./GoatBotFace";
import { useMobileGoatBotFace, useMobileGoatBotFaceMotion } from "./useMobileGoatBotFace";
import { useMobileMemberWaitingCount } from "./useMobileMemberStatus";
import { mobileGoatBotMemberPicture } from "./mobileGoatBotMembers";
import { MobileNeedsYouStrip } from "./MobileNeedsYouStrip";

/** Servers without member bots keep New bot disabled. */
const ignorePress = () => undefined;
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
  selectedKey?: string | null;
  slackEnabled: boolean;
  preview?: string;
  unread?: boolean;
  onOpenBot: (bot: BotRosterEntry) => void;
  /** Member bots: shown ones are in `bots`; these two lists carry the reverse states. */
  members?: {
    readonly hidden: ReadonlyArray<BotProfile>;
    readonly deleted: ReadonlyArray<BotProfile>;
    readonly canCreate: boolean;
    readonly onNewBot: () => void;
    /** Edit, hide, show, delete or restore; the panel asks what to do. */
    readonly onLongPressBot: (bot: BotRosterEntry) => void;
    /** Whether this person may restore a deleted bot; its row then offers Restore. */
    readonly canRestore: boolean;
    readonly onRestoreDeleted: (bot: BotProfile) => void;
  };
}) {
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const insets = useSafeAreaInsets();
  // Like the other workspace lists: the last row clears the tab bar; iOS already insets the safe area.
  const bottomClearance =
    Math.max(insets.bottom, useWorkspaceTabs()?.bottomClearance ?? 0) -
    (Platform.OS === "ios" ? insets.bottom : 0);
  const mainFace = useMobileGoatBotFace(null);
  const mainFaceLabel = goatBotFaceLabel(mainFace.state);
  const mainEmoji = goatBotAvatarEmoji(
    props.bots.find((bot) => bot.kind === "main")?.profile?.avatar,
  );
  const { scrollRef, rowRef, onScreen, measure, hold, settle, measureUnlessCoasting } =
    useRowOnScreen();
  // An emoji has no eyes, so the main row then never takes the one moving face.
  const mainMotion = useMobileGoatBotFaceMotion(
    mainFace.state,
    FACE_MOTION_RANK.list,
    mainFace.since,
    onScreen && mainEmoji === null,
  );
  return (
    <ScrollView
      ref={scrollRef}
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: bottomClearance }}
      onLayout={measure}
      onScrollBeginDrag={hold}
      onMomentumScrollBegin={hold}
      onScrollEndDrag={measureUnlessCoasting}
      onMomentumScrollEnd={settle}
    >
      {props.header}
      <MobileNeedsYouStrip
        bots={props.bots}
        mainRevision={`${props.preview ?? ""}|${props.unread === true}`}
        onOpenBot={props.onOpenBot}
      />
      {props.bots.map((bot) => {
        const key = bot.kind === "main" ? "main" : `bot:${bot.profile.botId}`;
        const selected = props.selectedKey === key;
        const longPress = props.members ? () => props.members?.onLongPressBot(bot) : undefined;
        if (bot.kind === "main") {
          // The main bot leads the list as one tile, like a contact the person returns to most.
          return (
            <Pressable
              key="main"
              ref={rowRef}
              onLayout={measure}
              accessibilityRole="button"
              onPress={() => props.onOpenBot(bot)}
              onLongPress={longPress}
              accessibilityState={{ selected }}
              accessibilityLabel={`${bot.profile?.name ?? "GOAT Bot"}${mainFaceLabel ? `, ${mainFaceLabel}` : ""}${props.unread ? ", unread" : ""}`}
              className={
                selected
                  ? "mx-4 my-2 items-center gap-2 rounded-2xl bg-thread-selected px-4 py-4"
                  : "mx-4 my-2 items-center gap-2 rounded-2xl px-4 py-4"
              }
            >
              <GoatBotFaceAvatar
                state={mainFace.state}
                size={88}
                motion={mainMotion}
                emoji={mainEmoji}
              />
              <Text numberOfLines={1} className="text-base font-semibold text-foreground">
                {bot.profile?.name ?? "GOAT Bot"}
              </Text>
              {props.preview ? (
                <View className="max-w-full flex-row items-center gap-1">
                  {props.unread ? (
                    <View
                      accessibilityElementsHidden
                      className="h-2 w-2 rounded-full bg-adaptive-blue-500-400"
                    />
                  ) : null}
                  <Text numberOfLines={1} className="shrink text-sm text-foreground-muted">
                    {props.preview}
                  </Text>
                </View>
              ) : null}
              {props.slackEnabled ? (
                <Text className="text-xs text-foreground-muted">Also in Slack</Text>
              ) : null}
            </Pressable>
          );
        }
        return (
          <Pressable
            key={key}
            accessibilityRole="button"
            onPress={() => props.onOpenBot(bot)}
            onLongPress={longPress}
            accessibilityState={{ selected }}
            accessibilityLabel={bot.profile.name}
            className={
              selected
                ? "flex-row items-center gap-3 bg-thread-selected px-4 py-3"
                : "flex-row items-center gap-3 px-4 py-3"
            }
          >
            <MemberRowContent bot={bot.profile} />
          </Pressable>
        );
      })}
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
                  <MemberRowContent bot={profile} />
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
            <View key={profile.botId} className="flex-row items-center pr-4">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${profile.name}, deleted`}
                accessibilityHint="Opens its archived conversation"
                {...(props.members?.canRestore
                  ? { onLongPress: () => props.members?.onRestoreDeleted(profile) }
                  : {})}
                onPress={() => props.onOpenBot({ kind: "member", profile })}
                className="min-h-[44px] flex-1 flex-row items-center justify-between px-4 py-3"
              >
                <Text className="text-foreground-muted">{profile.name}</Text>
                <Text className="text-foreground-muted">Deleted</Text>
              </Pressable>
              {props.members?.canRestore ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Restore ${profile.name}`}
                  onPress={() => props.members?.onRestoreDeleted(profile)}
                  className="min-h-[44px] min-w-[44px] items-center justify-center px-3"
                >
                  <Text className="font-goat-medium text-primary-text">Restore</Text>
                </Pressable>
              ) : null}
            </View>
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

/** A member row's text: the name with what waits on the person at the end. */
function BotRowText(props: { readonly name: string; readonly waitingCount?: number }) {
  const waiting = props.waitingCount ?? 0;
  return (
    <View className="min-w-0 flex-1 flex-row items-center gap-2">
      <Text numberOfLines={1} className="shrink font-semibold text-foreground">
        {props.name}
      </Text>
      {waiting > 0 ? (
        <Text
          accessibilityLabel={`${waiting} waiting for you`}
          className="text-xs font-semibold text-foreground"
        >
          {waiting}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A member's face from its own conversation shell and waiting count, then its row text; still,
 * since only the main row and headers move.
 */
function MemberRowContent({ bot }: { readonly bot: BotProfile }) {
  const waitingCount = useMobileMemberWaitingCount(bot);
  const face = useMobileGoatBotFace(
    null,
    { environmentId: bot.environmentId, threadId: bot.sessionThreadId },
    { waitingCount },
  );
  return (
    <>
      <GoatBotFaceAvatar
        state={face.state}
        size={40}
        motion={null}
        emoji={mobileGoatBotMemberPicture(bot)}
        accent={goatBotAccent(bot)}
      />
      <BotRowText name={bot.name} waitingCount={waitingCount} />
    </>
  );
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
