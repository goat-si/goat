import { MemoryReportLink } from "../settings/SettingsMemoryRouteScreen";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  goatBotAccent,
  goatBotName,
  goatBotNotesRefreshKey,
  hasGoatBotMarkdown,
  type GoatBotAccent,
  type GoatBotReplyRepository,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import { type BotProfile, ChannelTaskId, type EnvironmentId } from "@goat/contracts";
import { HeaderHeightContext } from "@react-navigation/elements";
import { StackActions, useNavigation } from "@react-navigation/native";
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View, useWindowDimensions } from "react-native";
import {
  KeyboardAvoidingView,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { IOS_NAV_BAR_HEIGHT } from "../../lib/layoutMetrics";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import { retainComposerAttachmentFile } from "../../lib/composerAttachmentFiles";
import {
  GoatBotAttachButton,
  GoatBotAttachmentStrip,
  releaseGoatBotAttachments,
} from "./GoatBotComposerAttachments";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import {
  startOpeningDetail,
  useSelectWorkspaceDetail,
} from "../workspace/useSelectWorkspaceDetail";
import { botThreadDetail, openBotThreadAction } from "./goatBotThreadNavigation";
import { useMobileGoatBotHomeSettings } from "./useMobileGoatBotHomeSettings";
import { useMobileGoatBotSession } from "./useMobileGoatBotSession";
import { GoatBotDayStamp } from "./GoatBotDayStamp";
import { GoatBotChipFace, GoatBotHeaderFace } from "./GoatBotFace";
import { GoatBotLinkedText } from "./GoatBotLinkedText";
import { GoatBotMarkdown } from "./GoatBotMarkdown";
import {
  GoatBotActivityLine,
  GoatBotBotCaption,
  GoatBotUpdateLabel,
  GoatBotPersonCaption,
  GoatBotPersonPill,
  GoatBotQuestionCard,
  GoatBotReplyQuote,
  goatBotRowGap,
  goatBotTime,
} from "./GoatBotMessageParts";
import { GoatBotModelPill } from "./GoatBotModelPill";
import { goatBotModelPillMenu } from "./goatBotModelPillMenu";
import { GoatBotReplyCards } from "./GoatBotReplyCards";
import { GoatBotTaskRow } from "./GoatBotTaskRow";
import { useMobileGoatBotModelMenu } from "./useMobileGoatBotModel";
import { useMobileGoatBotMemberModelMenu } from "./useMobileGoatBotMemberModel";
import {
  type GoatBotChatItem,
  GoatBotUnreadDividerRow,
  GoatBotUnreadPill,
  useGoatBotUnread,
} from "./GoatBotUnreadMarker";
import type { GoatBotVisitSnapshot } from "./useGoatBotVisitSnapshot";
import { goatBotChatRows } from "./goatBotChatRows";
import { goatBotComposerBottomPadding, goatBotInputMaxHeight } from "./goatBotComposerInsets";
import { GOAT_BOT_LIST_PADDING, goatBotFooterInView } from "./goatBotListEnd";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { MobileBotWork } from "./MobileBotWork";
import { MobileDeletedBotBanner } from "./MobileDeletedBotBanner";
import { mobileGoatBotMemberPicture } from "./mobileGoatBotMembers";

type ThreadSelection = Pick<EnvironmentThreadShell, "environmentId" | "id">;
const rowKey = (item: GoatBotChatItem) => item.id;
function availabilityCopy(mainName: string, openName: string) {
  return {
    ready: "Answers here, works in its own threads",
    connecting: `Connecting to ${mainName}…`,
    home_offline: `${mainName}’s computer is offline.`,
    offline: `${mainName}'s computer is offline. Messages will be available when it reconnects.`,
    unsupported: "Update the server to use GOAT Bot here.",
    permission: "This connection does not have permission to message GOAT Bot.",
    legacy_active: "Your global agent is still working. Check again when it finishes.",
    error: `Couldn't reach ${openName}`,
  };
}

type TaskRow = Extract<GoatBotRow, { kind: "task" }>;
type ListMetrics = Parameters<typeof goatBotFooterInView>[0];

export const GoatBotTimelineRow = memo(function GoatBotTimelineRow(props: {
  readonly row: GoatBotRow;
  readonly canSend: boolean;
  /** Sends an answer, to the task whose question offered it when the row names one. */
  readonly onSend: (answer: string, taskId?: ChannelTaskId) => boolean;
  readonly onRetry: (key: string) => void;
  readonly onDiscard?: (key: string) => void;
  readonly onSelectThread: (thread: ThreadSelection) => void;
  readonly onSelectTask?: (taskId: ChannelTaskId) => void;
  /** The environment whose bot history is shown; thread links in bot text open there. */
  readonly environmentId?: EnvironmentId | null;
  /** Who the conversation belongs to; its name heads each run of bot messages. */
  readonly botName?: string;
  /** The bot's profile avatar, shown beside its name. */
  readonly botEmoji?: string | null | undefined;
  /** A member bot's color for the person's messages; the theme's without one. */
  readonly accent?: GoatBotAccent | null | undefined;
}) {
  const { row } = props;
  const botName = props.botName ?? "GOAT Bot";
  const bodyText = useScaledTextRole("body");
  const [nowMs] = useState(() => Date.now());
  if (row.kind === "day") {
    return <GoatBotDayStamp at={row.at} nowMs={nowMs} formatTime={goatBotTime} />;
  }
  if (row.kind === "event") {
    return (
      <Text accessibilityRole="text" className="my-2 text-center text-xs text-foreground-muted">
        {row.text}
      </Text>
    );
  }
  const marginTop = goatBotRowGap(row.groupPosition);
  if (row.kind === "task") {
    const onSelectTask = props.onSelectTask;
    return (
      <View className="gap-1.5" style={{ marginTop }}>
        <GoatBotTaskRow
          card={row.card}
          onSelectThread={props.onSelectThread}
          onOpenTask={
            onSelectTask ? () => onSelectTask(ChannelTaskId.make(row.card.key)) : undefined
          }
        />
        <GoatBotBotCaption at={row.createdAt} groupPosition={row.groupPosition} />
      </View>
    );
  }
  if (row.kind === "user") {
    const time = goatBotTime(row.createdAt);
    const onAccent = props.accent ? { color: props.accent.foreground } : null;
    return (
      <View className="items-end gap-1" style={{ marginTop }}>
        <GoatBotPersonPill accent={props.accent}>
          <View className="gap-1">
            {row.text ? (
              <Text
                selectable
                accessibilityLabel={time ? `You, ${time}: ${row.text}` : `You: ${row.text}`}
                className="text-goat-person-message-foreground"
                style={{ ...bodyText, ...onAccent }}
              >
                {row.text}
              </Text>
            ) : null}
            {row.attachments?.map((file) => (
              <Text
                key={file.id}
                numberOfLines={1}
                className="text-goat-person-message-foreground"
                // The text colour was chosen for the opaque accent; dimming it would lose contrast.
                style={{ ...(onAccent ? {} : { opacity: 0.85 }), ...bodyText, ...onAccent }}
              >
                {(file.type === "image" ? "Photo · " : "File · ") + file.name}
              </Text>
            ))}
          </View>
        </GoatBotPersonPill>
        <GoatBotPersonCaption
          row={row}
          botName={botName}
          canSend={props.canSend}
          onRetry={props.onRetry}
          onDiscard={props.onDiscard}
        />
      </View>
    );
  }
  const renderText = (text: string, repository?: GoatBotReplyRepository | null) =>
    hasGoatBotMarkdown(text) ? (
      <GoatBotMarkdown
        text={text}
        repository={repository}
        failed={row.tone === "failure"}
        environmentId={props.environmentId ?? null}
        onSelectThread={props.onSelectThread}
      />
    ) : (
      <Text
        selectable
        className={row.tone === "failure" ? "text-danger-foreground" : "text-foreground"}
        style={bodyText}
        accessibilityLabel={row.tone === "failure" ? `Failed: ${text}` : undefined}
      >
        <GoatBotLinkedText text={text} repository={repository} />
      </Text>
    );
  const memory = row.memory ? <MemoryReportLink reference={row.memory} /> : null;
  return (
    <View className="gap-1.5" style={{ marginTop }}>
      {row.firstInGroup && row.proactive ? (
        <GoatBotUpdateLabel
          at={row.createdAt}
          name={botName}
          emoji={props.botEmoji}
          accent={props.accent}
        />
      ) : null}
      {row.replyTo ? <GoatBotReplyQuote text={row.replyTo} /> : null}
      {row.options.length > 0 || row.answer !== undefined ? (
        <GoatBotQuestionCard
          row={row}
          canAnswer={props.canSend}
          onPick={(answer) =>
            props.onSend(
              answer,
              row.answerTaskId === undefined ? undefined : ChannelTaskId.make(row.answerTaskId),
            )
          }
        >
          {renderText(row.text)}
          {memory}
        </GoatBotQuestionCard>
      ) : (
        <GoatBotReplyCards text={row.text} renderText={renderText} footer={memory} />
      )}
      <GoatBotBotCaption at={row.createdAt} groupPosition={row.groupPosition} />
    </View>
  );
});

export function GoatBotScreen(props: {
  readonly visible: boolean;
  readonly taskId?: ChannelTaskId;
  /** A member bot whose conversation this is; the main bot's when absent. */
  readonly member?: BotProfile | null;
  /** Where the person had read the main chat up to when this visit began. */
  readonly readSnapshot?: GoatBotVisitSnapshot | null;
  /** The main bot's profile, which names its chat; absent before the server keeps profiles. */
  readonly main?: BotProfile | null;
  /** Restores a deleted member; absent when this person may not manage bots. */
  readonly onRestoreMember?: (() => Promise<boolean>) | undefined;
  readonly onSelectThread?: (thread: ThreadSelection) => void;
  /** Floating tabs cover the bottom of the screen; the composer rests above them. */
  readonly floatingTabs?: { readonly bottomSafeArea: number };
}) {
  const member = props.member ?? null;
  const mainName = goatBotName(props.main ?? null);
  const session = useMobileGoatBotSession(props.visible, props.taskId ?? null, member);
  const title = goatBotName(member ?? props.main ?? null);
  const copy = availabilityCopy(mainName, title);
  const botEmoji = member ? mobileGoatBotMemberPicture(member) : props.main?.avatar;
  // A member bot's color carries the person's messages and Send; the main bot keeps the theme's.
  // Kept while the role and colour stay the same, so the list redraws its rows only when they change.
  const accentRole = member?.role;
  const accentColor = member?.color?.toUpperCase();
  const accent = useMemo(
    () =>
      accentRole === undefined ? null : goatBotAccent({ role: accentRole, color: accentColor }),
    [accentRole, accentColor],
  );
  const taskId = session.supportsTaskThreads ? props.taskId : undefined;
  const homeSettings = useMobileGoatBotHomeSettings();
  const moveTarget = homeSettings.moveTarget;
  const { themeAppearance } = useAppearancePreferences();
  const bodyText = useScaledTextRole("body");
  const selectDetail = useSelectWorkspaceDetail();
  const navigation = useNavigation();
  const selectThread = useCallback(
    (thread: ThreadSelection) => {
      const detail = botThreadDetail(thread);
      // Android shows one page at a time; iOS opens the thread over the bot, so Back returns to it.
      if (Platform.OS === "android") return selectDetail(detail);
      startOpeningDetail(detail);
      navigation.dispatch(openBotThreadAction(thread));
    },
    [selectDetail, navigation],
  );
  const onSelectThread = props.onSelectThread ?? selectThread;
  const onSelectTask = useCallback(
    (taskId: ChannelTaskId) =>
      navigation.dispatch(
        StackActions.push("GoatBot", member ? { taskId, botId: member.botId } : { taskId }),
      ),
    [navigation, member],
  );
  const insets = useSafeAreaInsets();
  const composerPadding = goatBotComposerBottomPadding(
    props.floatingTabs
      ? { bottomSafeArea: props.floatingTabs.bottomSafeArea, floatingTabs: true }
      : { bottomSafeArea: insets.bottom, floatingTabs: false },
  );
  // The padding follows the keyboard frame by frame on the UI thread, in step with the
  // KeyboardAvoidingView lift, so the composer never jumps when the keyboard opens or closes.
  const keyboard = useReanimatedKeyboardAnimation();
  const composerPaddingStyle = useAnimatedStyle(() => ({
    paddingBottom:
      composerPadding.closed +
      (composerPadding.open - composerPadding.closed) * keyboard.progress.value,
  }));
  // A glass header is transparent: the list reaches under it and UIKit insets it, so the header's
  // scroll-edge effect covers the rows. Anything pinned above the list starts below that header.
  // An opaque header already sits above the content.
  const headerHeight = useContext(HeaderHeightContext) ?? insets.top + IOS_NAV_BAR_HEIGHT;
  const hasBanner = session.availability !== "ready";
  const homeError = homeSettings.error;
  const topInset = Platform.OS === "ios" && NATIVE_LIQUID_GLASS_SUPPORTED ? headerHeight : 0;
  // LegendList cannot see UIKit's adjusted inset; without it, end alignment pads a short
  // conversation by the header height and its last message starts below the composer's top.
  const listTopInset = 0;
  const [text, setText] = useState("");
  const [homeOpen, setHomeOpen] = useState(false);
  const openHome = useCallback(() => setHomeOpen(true), []);
  const memberModelMenu = useMobileGoatBotMemberModelMenu(member, goatBotName(props.main ?? null));
  const mainModelMenu = useMobileGoatBotModelMenu();
  const [attachments, setAttachments] = useState<ReadonlyArray<DraftComposerAttachment>>([]);
  const draftFiles = useRef(new Map<string, () => void>());
  const pickerLifetime = useRef<AbortController | null>(null);
  // oxlint-disable-next-line goat/react-effect-budget -- Release draft file ownership when the screen unmounts.
  useEffect(() => {
    const controller = new AbortController();
    pickerLifetime.current = controller;
    return () => {
      controller.abort();
      pickerLifetime.current = null;
      for (const release of draftFiles.current.values()) release();
      draftFiles.current.clear();
    };
  }, []);
  // What the list last reported about its scroll, size and footer; the progress line moves only
  // while enough of it shows. Kept in a ref so scroll events re-render only when that answer flips.
  const listMetrics = useRef<ListMetrics>({
    offsetY: 0,
    viewportHeight: 0,
    contentHeight: 0,
    footerHeight: 0,
  });
  const [footerInView, setFooterInView] = useState(false);
  const measureList = useCallback((next: Partial<ListMetrics>) => {
    Object.assign(listMetrics.current, next);
    setFooterInView(goatBotFooterInView(listMetrics.current));
  }, []);
  // The shared rows decide which work cards the main chat keeps (conversationOnly): only work the
  // home lists and whose ending the chat told leaves it. A task's own view has its card above.
  const hidesTaskCards = taskId !== undefined;
  const visibleRows = useMemo(
    () =>
      hidesTaskCards ? goatBotChatRows(session.rows, (row) => row.kind === "task") : session.rows,
    [hidesTaskCards, session.rows],
  );
  // The "New" line and its pill belong to the main chat, whose visits the route records.
  const unread = useGoatBotUnread(
    visibleRows,
    taskId !== undefined || member !== null ? null : props.readSnapshot,
  );
  const listRef = useRef<LegendListRef>(null);
  const { clear: clearUnread } = unread;
  const { onAnswer: answer } = session;
  const onAnswer = useCallback(
    (text: string, answerTask?: ChannelTaskId) => {
      const sent = answer(text, answerTask);
      if (sent) clearUnread();
      return sent;
    },
    [answer, clearUnread],
  );
  const [inputHeight, setInputHeight] = useState(44);
  const inputMaxHeight = goatBotInputMaxHeight(useWindowDimensions().height);
  const focusDivider = unread.focusDivider;
  const listExtraData = useMemo(() => ({ accent, focusDivider }), [accent, focusDivider]);
  const renderItem = useCallback(
    ({ item }: { item: GoatBotChatItem }) =>
      item.kind === "unread" ? (
        <GoatBotUnreadDividerRow focus={unread.focusDivider} onFocused={unread.dividerFocused} />
      ) : (
        <GoatBotTimelineRow
          row={item}
          canSend={session.canSend}
          onSend={onAnswer}
          onRetry={session.onRetryInput}
          onDiscard={session.onDiscardInput}
          onSelectThread={onSelectThread}
          onSelectTask={!taskId && session.supportsTaskThreads ? onSelectTask : undefined}
          environmentId={session.historyEnvironmentId}
          botName={title}
          botEmoji={botEmoji}
          accent={accent}
        />
      ),
    [
      unread.focusDivider,
      unread.dividerFocused,
      session.canSend,
      onAnswer,
      session.onRetryInput,
      session.onDiscardInput,
      onSelectThread,
      onSelectTask,
      taskId,
      session.supportsTaskThreads,
      session.historyEnvironmentId,
      title,
      botEmoji,
      accent,
    ],
  );
  const send = () => {
    if (session.onSend(text, attachments)) {
      unread.clear();
      for (const release of draftFiles.current.values()) release();
      draftFiles.current.clear();
      setText("");
      setAttachments([]);
      setInputHeight(44);
    }
  };
  const support = session.attachmentSupport;
  const removeAttachment = (id: string) => {
    draftFiles.current.get(id)?.();
    draftFiles.current.delete(id);
    releaseGoatBotAttachments(attachments.filter((attachment) => attachment.id === id));
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };
  const taskCard = taskId
    ? session.rows.find((row): row is TaskRow => row.kind === "task" && row.card.key === taskId)
    : undefined;
  const hasDraft = text.trim().length > 0 || attachments.length > 0;
  const canSubmit = session.canSend && hasDraft;
  const modelMenu = goatBotModelPillMenu(memberModelMenu, mainModelMenu, member !== null);
  const chatTasks = useMemo(
    () =>
      taskId === undefined && session.supportsTaskThreads
        ? session.rows.flatMap((row) => (row.kind === "task" ? [row.card] : []))
        : [],
    [taskId, session.supportsTaskThreads, session.rows],
  );
  return (
    <KeyboardAvoidingView className="flex-1 bg-screen" automaticOffset behavior="height">
      {Platform.OS === "ios" ? (
        <GoatBotHeaderFace
          activity={session.activity ?? null}
          title={title}
          emoji={botEmoji}
          accent={accent}
          onPress={taskId ? undefined : openHome}
          {...(member
            ? {
                conversation: {
                  environmentId: member.environmentId,
                  threadId: member.sessionThreadId,
                },
              }
            : {})}
        />
      ) : null}
      <View style={{ paddingTop: topInset }}>
        <MobileBotWork
          taskId={taskId}
          open={homeOpen}
          onOpenChange={setHomeOpen}
          chipFace={
            Platform.OS === "android" ? (
              <GoatBotChipFace
                activity={session.activity ?? null}
                emoji={botEmoji}
                accent={accent}
                {...(member
                  ? {
                      conversation: {
                        environmentId: member.environmentId,
                        threadId: member.sessionThreadId,
                      },
                    }
                  : {})}
              />
            ) : null
          }
          visible={props.visible}
          onOpenTask={onSelectTask}
          onOpenThread={onSelectThread}
          member={
            member
              ? {
                  botId: member.botId,
                  environmentId: member.environmentId,
                  threadId: member.sessionThreadId,
                  name: member.name,
                  defaultModelSelection: member.defaultModelSelection,
                }
              : null
          }
          turnsWaiting={session.turnsWaiting}
          botName={title}
          botAvatar={botEmoji}
          botAccent={accent}
          main={props.main ?? null}
          onDraft={session.canSend ? setText : undefined}
          notesRefreshKey={goatBotNotesRefreshKey(session.rows)}
          workRevision={session.workRevision}
          chatTasks={chatTasks}
          taskCardInfo={taskCard?.card ?? null}
          taskCard={
            taskCard ? (
              <GoatBotTaskRow card={taskCard.card} onSelectThread={onSelectThread} />
            ) : null
          }
        />
      </View>
      {member?.state === "deleted" ? (
        <MobileDeletedBotBanner member={member} onRestore={props.onRestoreMember} />
      ) : null}
      {hasBanner ? (
        <View
          accessibilityRole="alert"
          className="gap-2 border-b border-border px-4 py-3"
          style={{ paddingTop: 12 }}
        >
          <Text className="text-sm text-foreground-muted">
            {session.availability === "home_offline"
              ? session.homeKnown
                ? `${mainName} runs on ${session.homeLabel}, which isn't connected.`
                : `${mainName}'s home (${session.homeLabel}) isn't a computer this app knows.`
              : session.availability === "error"
                ? (session.error ?? copy.error)
                : copy[session.availability]}
          </Text>
          {session.availability === "home_offline" && moveTarget ? (
            <Pressable
              accessibilityRole="button"
              disabled={homeSettings.busy}
              onPress={() => {
                if (moveTarget) homeSettings.changeHome(moveTarget.environmentId);
              }}
              className="self-start rounded-lg border border-border px-3 py-2"
            >
              <Text className="text-sm text-foreground">
                Move {mainName} to {moveTarget.label}
              </Text>
            </Pressable>
          ) : null}
          {session.availability === "error" || session.availability === "legacy_active" ? (
            <Pressable
              accessibilityRole="button"
              onPress={session.onRetryAvailability}
              className="self-start rounded-lg border border-border px-3 py-2"
            >
              <Text className="text-sm text-foreground">Try again</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {homeError ? (
        <Text
          accessibilityRole="alert"
          className="px-4 py-2 text-sm text-danger-foreground"
          style={hasBanner ? undefined : { paddingTop: 8 }}
        >
          {homeError}
        </Text>
      ) : null}
      <View style={{ flex: 1 }}>
        <LegendList
          renderScrollComponent={NativeScrollView}
          style={{ flex: 1 }}
          ref={listRef}
          data={unread.items}
          keyExtractor={rowKey}
          onViewableItemsChanged={({ viewableItems }) =>
            unread.onViewable(viewableItems.map((entry) => entry.index))
          }
          renderItem={renderItem}
          // Rows are memoized by key, data and this: a new accent must reach the pills already shown,
          // and the "New" line must learn when to take VoiceOver focus.
          extraData={listExtraData}
          initialScrollAtEnd
          maintainScrollAtEnd
          alignItemsAtEnd
          keyboardShouldPersistTaps="handled"
          // A manual contentInset would zero UIKit's header inset and its scroll-edge region.
          contentInsetAdjustmentBehavior="automatic"
          contentInsetStartAdjustment={listTopInset}
          contentContainerStyle={{ padding: GOAT_BOT_LIST_PADDING }}
          scrollEventThrottle={100}
          onScroll={(event) => {
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
            measureList({
              offsetY: contentOffset.y,
              viewportHeight: layoutMeasurement.height,
              contentHeight: contentSize.height,
            });
          }}
          onContentSizeChange={(_width, height) => measureList({ contentHeight: height })}
          onLayout={(event) => measureList({ viewportHeight: event.nativeEvent.layout.height })}
          ListEmptyComponent={
            <Text className="py-6 text-center text-foreground-muted">
              {taskId
                ? "Messages for this task will appear here."
                : `Ask ${title} for anything. It answers here and starts work in its own threads.`}
            </Text>
          }
          ListFooterComponent={
            !taskId && session.activity ? (
              <View
                testID="goat-bot-progress-line"
                onLayout={(event) => measureList({ footerHeight: event.nativeEvent.layout.height })}
              >
                <GoatBotActivityLine
                  activity={session.activity}
                  botName={title}
                  emoji={botEmoji}
                  accent={accent}
                  inView={footerInView}
                />
              </View>
            ) : null
          }
        />
        {unread.pill !== null ? (
          <View
            pointerEvents="box-none"
            style={{ position: "absolute", left: 0, right: 0, top: topInset }}
          >
            <GoatBotUnreadPill
              count={unread.pill}
              onPress={() => {
                unread.jump();
                void listRef.current?.scrollToIndex({
                  index: unread.dividerIndex,
                  viewPosition: 0,
                  viewOffset: topInset,
                  animated: true,
                });
              }}
              onDismiss={unread.settle}
            />
          </View>
        ) : null}
      </View>
      <Animated.View
        className="gap-2 border-t border-border px-4 pt-2"
        style={composerPaddingStyle}
      >
        <GoatBotAttachmentStrip
          environmentId={session.historyEnvironmentId}
          attachments={attachments}
          onRemove={removeAttachment}
        />
        {/* Two rows on a phone: the field, then attach, model and send under the thumb. */}
        <TextInput
          accessibilityLabel={`Message ${title}`}
          placeholder={`Message ${title}`}
          placeholderTextColorClassName="accent-placeholder"
          value={text}
          onChangeText={setText}
          multiline
          editable={session.canSend}
          accessibilityState={{ disabled: !session.canSend }}
          onContentSizeChange={(event) =>
            setInputHeight(Math.min(160, Math.max(44, event.nativeEvent.contentSize.height)))
          }
          className="px-3 py-2 text-foreground"
          style={{
            height: Math.min(inputHeight, inputMaxHeight),
            minHeight: 44,
            borderRadius: 22,
            borderWidth: 0.5,
            borderColor: themeAppearance === "light" ? "#C6C6C8" : "#545458",
            backgroundColor: themeAppearance === "light" ? "#F2F2F7" : "#1C1C1E",
            ...bodyText,
          }}
        />
        <View className="min-h-[44px] flex-row items-center gap-2">
          {support ? (
            <GoatBotAttachButton
              disabled={!session.canSend}
              existingCount={attachments.length}
              maxUploadBytes={support.maxUploadBytes}
              getLifetime={() => pickerLifetime.current?.signal}
              onPicked={(picked) => {
                if (!pickerLifetime.current || pickerLifetime.current.signal.aborted) {
                  releaseGoatBotAttachments(picked);
                  return;
                }
                for (const attachment of picked) {
                  if (attachment.fileUri !== undefined) {
                    draftFiles.current.set(
                      attachment.id,
                      retainComposerAttachmentFile(attachment.fileUri, () =>
                        releaseGoatBotAttachments([attachment]),
                      ),
                    );
                  }
                }
                setAttachments((current) => [...current, ...picked]);
              }}
            />
          ) : null}
          {modelMenu ? <GoatBotModelPill menu={modelMenu} /> : null}
          <View className="flex-1" />
          {/* Send shows only once there is something to send. */}
          {hasDraft ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send message"
              disabled={!canSubmit}
              onPress={send}
              className="items-center justify-center"
              style={{
                width: 44,
                height: 44,
                opacity: canSubmit ? 1 : 0.45,
              }}
            >
              <View
                className={
                  accent
                    ? "items-center justify-center"
                    : "items-center justify-center bg-composer-send"
                }
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  ...(accent ? { backgroundColor: accent.background } : {}),
                }}
              >
                <Text
                  className="text-xl font-semibold text-primary-foreground"
                  style={accent ? { color: accent.foreground } : undefined}
                >
                  ↑
                </Text>
              </View>
            </Pressable>
          ) : null}
        </View>
      </Animated.View>
    </KeyboardAvoidingView>
  );
}
