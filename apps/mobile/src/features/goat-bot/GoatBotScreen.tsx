import { MemoryReportLink } from "../settings/SettingsMemoryRouteScreen";
import { LegendList } from "@legendapp/list/react-native";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  goatBotReceiptLabel,
  goatBotName,
  goatBotNotesRefreshKey,
  hasGoatBotMarkdown,
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
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useMobileGoatBotHomeSettings } from "./useMobileGoatBotHomeSettings";
import { useMobileGoatBotSession } from "./useMobileGoatBotSession";
import { GoatBotBubble } from "./GoatBotBubble";
import { GoatBotDayStamp } from "./GoatBotDayStamp";
import { GoatBotHeaderFace } from "./GoatBotFace";
import { GoatBotLinkedText } from "./GoatBotLinkedText";
import { GoatBotMarkdown } from "./GoatBotMarkdown";
import { GOAT_BOT_BUBBLE_COLORS, goatBotBubbleLayout } from "./goatBotBubbleStyle";
import { goatBotComposerBottomPadding, goatBotInputMaxHeight } from "./goatBotComposerInsets";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { MobileBotWork } from "./MobileBotWork";
import { MobileDeletedBotBanner } from "./MobileDeletedBotBanner";

type ThreadSelection = Pick<EnvironmentThreadShell, "environmentId" | "id">;
const rowKey = (row: GoatBotRow) => row.id;
const receiptTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
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

type GoatBotTaskRow = Extract<GoatBotRow, { kind: "task" }>;
const SUMMARY_LINES = 4;
/** About four lines of body text in a card at its narrowest. */
const SUMMARY_CHARS = 160;

/** A piece of work GOAT Bot started; remote work names its machine and waits for it to connect. */
export function GoatBotTaskCard(props: {
  readonly card: GoatBotTaskRow["card"];
  readonly onSelectThread: (thread: ThreadSelection) => void;
  readonly tail: boolean;
}) {
  const { card } = props;
  const bodyText = useScaledTextRole("body");
  const target = card.target;
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const unreachableHost =
    target.kind === "thread" &&
    target.host !== undefined &&
    !connectedEnvironments.some(
      (environment) =>
        environment.environmentId === target.environmentId &&
        environment.connectionState === "connected",
    )
      ? target.host
      : null;
  const action =
    target.kind !== "thread"
      ? target.label
      : unreachableHost !== null
        ? `Connect ${unreachableHost} to open`
        : "Open thread";
  return (
    <GoatBotBubble side="in" tail={props.tail} maxWidth="90%">
      {(textColor) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${card.title}. ${card.statusLabel}.${card.attemptLabel ? ` ${card.attemptLabel}.` : ""}${card.attentionLabel ? ` ${card.attentionLabel}.` : ""}${card.continuationLabel ? ` ${card.continuationLabel}.` : ""} ${(card.evidenceLabels ?? []).join(". ")} ${action}`}
          disabled={target.kind !== "thread" || unreachableHost !== null}
          onPress={() => {
            if (target.kind === "thread" && unreachableHost === null)
              props.onSelectThread({ environmentId: target.environmentId, id: target.threadId });
          }}
          className="gap-1"
        >
          <Text className="text-xs" style={{ color: textColor, opacity: 0.7 }}>
            {card.statusLabel}
            {card.attemptLabel ? ` · ${card.attemptLabel}` : ""}
            {card.attentionLabel ? ` · ${card.attentionLabel}` : ""}
          </Text>
          <Text className="font-semibold" style={{ color: textColor, ...bodyText }}>
            {card.title}
          </Text>
          {card.sourceLabel ? (
            <Text className="text-xs" style={{ color: textColor, opacity: 0.7 }}>
              {card.sourceLabel}
            </Text>
          ) : null}
          {card.continuationLabel ? (
            <Text className="text-xs" style={{ color: textColor, opacity: 0.7 }}>
              {card.continuationLabel}
            </Text>
          ) : null}
          {card.summary ? (
            <GoatBotTaskSummary
              summary={card.summary}
              textColor={textColor}
              environmentId={card.target.kind === "thread" ? card.target.environmentId : null}
              onSelectThread={props.onSelectThread}
            />
          ) : null}
          {card.pullRequests.length > 0 ? (
            <Text className="text-xs" style={{ color: textColor, opacity: 0.7 }}>
              {"Pull requests: " +
                card.pullRequests.map((pullRequest) => pullRequest.label).join(", ")}
            </Text>
          ) : null}
          {card.evidenceLabels?.map((label) => (
            <Text key={label} className="text-xs" style={{ color: textColor, opacity: 0.8 }}>
              {label}
            </Text>
          ))}
          <Text className="text-xs" style={{ color: textColor, opacity: 0.7 }}>
            {action === "Open thread" ? "Open thread ↗" : action}
          </Text>
        </Pressable>
      )}
    </GoatBotBubble>
  );
}

/** The card is the task's result, so a long summary opens in place instead of staying cut off. */
function GoatBotTaskSummary(props: {
  readonly summary: string;
  readonly textColor: string;
  readonly environmentId: EnvironmentId | null;
  readonly onSelectThread: (thread: ThreadSelection) => void;
}) {
  const bodyText = useScaledTextRole("body");
  const [expanded, setExpanded] = useState(false);
  // Counted from the text: line metrics under numberOfLines differ between iOS and Android.
  const long =
    props.summary.length > SUMMARY_CHARS || props.summary.split("\n").length > SUMMARY_LINES;
  return (
    <View className="gap-0.5">
      {(expanded || !long) && hasGoatBotMarkdown(props.summary) ? (
        <GoatBotMarkdown
          text={props.summary}
          textColor={props.textColor}
          environmentId={props.environmentId}
          onSelectThread={props.onSelectThread}
        />
      ) : (
        // A collapsed long summary stays a bounded plain preview; the native renderer cannot clamp.
        <Text
          numberOfLines={expanded ? undefined : SUMMARY_LINES}
          style={{ color: props.textColor, ...bodyText }}
        >
          <GoatBotLinkedText text={props.summary} />
        </Text>
      )}
      {long ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((open) => !open)}
          hitSlop={8}
        >
          <Text className="text-xs font-medium" style={{ color: props.textColor, opacity: 0.8 }}>
            {expanded ? "Show less" : "Show more"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

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
  /** Who the conversation belongs to; a member bot labels its own updates. */
  readonly botName?: string;
}) {
  const { row } = props;
  const { themeAppearance } = useAppearancePreferences();
  const outgoingColor = GOAT_BOT_BUBBLE_COLORS[themeAppearance].out;
  const bodyText = useScaledTextRole("body");
  const receiptText = useScaledTextRole("caption");
  const [nowMs] = useState(() => Date.now());
  if (row.kind === "day") {
    return <GoatBotDayStamp at={row.at} nowMs={nowMs} formatTime={receiptTime} />;
  }
  if (row.kind === "event") {
    return (
      <Text accessibilityRole="text" className="my-2 text-center text-xs text-foreground-muted">
        {row.text}
      </Text>
    );
  }
  const layout = goatBotBubbleLayout(row.groupPosition);
  if (row.kind === "task") {
    if (props.onSelectTask) {
      return (
        <Pressable
          accessibilityRole="button"
          onPress={() => props.onSelectTask?.(ChannelTaskId.make(row.card.key))}
          className="min-h-[44px] self-start justify-center rounded-full border border-border px-3 py-2"
        >
          <Text className="text-foreground">
            Task thread · {row.card.title} · {row.card.statusLabel}
          </Text>
        </Pressable>
      );
    }
    return (
      <View style={{ marginTop: layout.marginTop, alignItems: "flex-start" }}>
        <GoatBotTaskCard card={row.card} onSelectThread={props.onSelectThread} tail={layout.tail} />
      </View>
    );
  }
  if (row.kind === "user") {
    const delivery = row.delivery;
    const receipt = goatBotReceiptLabel(delivery, receiptTime, props.botName);
    return (
      <View className="items-end gap-1" style={{ marginTop: layout.marginTop }}>
        <GoatBotBubble side="out" tail={layout.tail}>
          {(textColor) => (
            <View className="gap-1">
              {row.text ? (
                <Text selectable style={{ color: textColor, ...bodyText }}>
                  {row.text}
                </Text>
              ) : null}
              {row.attachments?.map((file) => (
                <Text
                  key={file.id}
                  numberOfLines={1}
                  style={{ color: textColor, opacity: 0.85, ...bodyText }}
                >
                  {(file.type === "image" ? "Photo · " : "File · ") + file.name}
                </Text>
              ))}
            </View>
          )}
        </GoatBotBubble>
        {row.showReceipt || delivery.state === "failed" ? (
          <View className="flex-row items-center gap-2">
            <Text
              className="text-foreground-muted"
              style={receiptText}
              accessibilityLabel={receipt?.accessibleText}
            >
              {delivery.state === "failed"
                ? (delivery.rejectionReason ?? "Not Delivered")
                : receipt?.text}
            </Text>
            {delivery.state === "failed" && delivery.rejectionReason === undefined ? (
              <Pressable
                accessibilityRole="button"
                disabled={!props.canSend}
                onPress={() => props.onRetry(delivery.clientKey)}
                className="p-2"
              >
                <Text className="text-sm text-foreground">Retry</Text>
              </Pressable>
            ) : null}
            {delivery.state === "failed" ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => props.onDiscard?.(delivery.clientKey)}
                className="p-2"
              >
                <Text className="text-sm text-foreground">Discard</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }
  return (
    <View className="items-start gap-1" style={{ marginTop: layout.marginTop }}>
      {row.proactive && row.firstInGroup ? (
        <Text className="text-xs text-foreground-muted">
          {props.botName ?? "GOAT Bot"} · Update
        </Text>
      ) : null}
      <GoatBotBubble side="in" tail={layout.tail}>
        {(textColor) => (
          <View className="gap-1">
            {row.replyTo ? (
              <Text
                numberOfLines={2}
                className="border-l-2 border-border pl-2 text-xs"
                style={{ color: textColor, opacity: 0.7 }}
              >
                {row.replyTo}
              </Text>
            ) : null}
            {hasGoatBotMarkdown(row.text) ? (
              <GoatBotMarkdown
                text={row.text}
                textColor={textColor}
                failed={row.tone === "failure"}
                environmentId={props.environmentId ?? null}
                onSelectThread={props.onSelectThread}
              />
            ) : (
              <Text
                selectable
                className={row.tone === "failure" ? "text-danger-foreground" : undefined}
                style={row.tone === "failure" ? bodyText : { color: textColor, ...bodyText }}
                accessibilityLabel={row.tone === "failure" ? `Failed: ${row.text}` : undefined}
              >
                <GoatBotLinkedText text={row.text} />
              </Text>
            )}
          </View>
        )}
      </GoatBotBubble>
      {row.memory ? <MemoryReportLink reference={row.memory} /> : null}
      {row.options.length > 0 ? (
        <View
          accessibilityLabel="Suggested answers"
          className="max-w-[90%] flex-row flex-wrap gap-2"
        >
          {row.options.map((answer) => (
            <Pressable
              key={answer}
              accessibilityRole="button"
              disabled={!props.canSend}
              onPress={() =>
                props.onSend(
                  answer,
                  row.answerTaskId === undefined ? undefined : ChannelTaskId.make(row.answerTaskId),
                )
              }
              // 44pt touch target; min-h-11 is only 38.5pt at the app's 14pt rem.
              className="min-h-[44px] justify-center rounded-full border px-3 py-2"
              style={{ borderColor: outgoingColor }}
            >
              <Text className="text-sm" style={{ color: outgoingColor }}>
                {answer}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
});

/** What GOAT Bot is doing, in place of typing dots. Static, so the list repaints nothing. */
function GoatBotActivityBubble({ text }: { readonly text: string }) {
  const bodyText = useScaledTextRole("body");
  return (
    <View accessibilityRole="text" accessibilityLiveRegion="polite" className="self-start">
      <GoatBotBubble side="in" tail>
        {(textColor) => (
          <Text style={{ color: textColor, opacity: 0.72, ...bodyText }}>{text}</Text>
        )}
      </GoatBotBubble>
    </View>
  );
}

export function GoatBotScreen(props: {
  readonly visible: boolean;
  readonly taskId?: ChannelTaskId;
  /** A member bot whose conversation this is; the main bot's when absent. */
  readonly member?: BotProfile | null;
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
  const session = useMobileGoatBotSession(
    props.visible,
    props.taskId ?? null,
    member,
    props.main ?? null,
  );
  const title = goatBotName(member ?? props.main ?? null);
  const copy = availabilityCopy(mainName, title);
  const taskId = session.supportsTaskThreads ? props.taskId : undefined;
  const homeSettings = useMobileGoatBotHomeSettings();
  const moveTarget = homeSettings.moveTarget;
  const { themeAppearance } = useAppearancePreferences();
  const bodyText = useScaledTextRole("body");
  const outgoingColor = GOAT_BOT_BUBBLE_COLORS[themeAppearance].out;
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
  const [inputHeight, setInputHeight] = useState(44);
  const inputMaxHeight = goatBotInputMaxHeight(useWindowDimensions().height);
  const renderItem = useCallback(
    ({ item }: { item: GoatBotRow }) => (
      <GoatBotTimelineRow
        row={item}
        canSend={session.canSend}
        onSend={session.onAnswer}
        onRetry={session.onRetryInput}
        onDiscard={session.onDiscardInput}
        onSelectThread={onSelectThread}
        onSelectTask={!taskId && session.supportsTaskThreads ? onSelectTask : undefined}
        environmentId={session.historyEnvironmentId}
        botName={title}
      />
    ),
    [
      session.canSend,
      session.onAnswer,
      session.onRetryInput,
      session.onDiscardInput,
      onSelectThread,
      onSelectTask,
      taskId,
      session.supportsTaskThreads,
      session.historyEnvironmentId,
      title,
    ],
  );
  const send = () => {
    if (session.onSend(text, attachments)) {
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
    ? session.rows.find(
        (row): row is GoatBotTaskRow => row.kind === "task" && row.card.key === taskId,
      )
    : undefined;
  const canSubmit = session.canSend && (text.trim().length > 0 || attachments.length > 0);
  const visibleRows = useMemo(
    () => (taskId ? session.rows.filter((row) => row.kind !== "task") : session.rows),
    [taskId, session.rows],
  );
  return (
    <KeyboardAvoidingView className="flex-1 bg-screen" automaticOffset behavior="height">
      {Platform.OS === "ios" ? (
        <GoatBotHeaderFace
          activity={session.activity ?? null}
          title={title}
          emoji={(member ?? props.main ?? null)?.avatar}
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
          visible={props.visible}
          onOpenTask={onSelectTask}
          onOpenThread={onSelectThread}
          member={
            member
              ? {
                  botId: member.botId,
                  threadId: member.sessionThreadId,
                  name: member.name,
                  defaultModelSelection: member.defaultModelSelection,
                }
              : null
          }
          turnsWaiting={session.turnsWaiting}
          botName={title}
          onDraft={session.canSend ? setText : undefined}
          notesRefreshKey={goatBotNotesRefreshKey(session.rows)}
          taskCard={
            taskCard ? (
              <GoatBotTaskCard card={taskCard.card} onSelectThread={onSelectThread} tail={false} />
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
      <LegendList
        renderScrollComponent={NativeScrollView}
        style={{ flex: 1 }}
        data={visibleRows}
        keyExtractor={rowKey}
        renderItem={renderItem}
        initialScrollAtEnd
        maintainScrollAtEnd
        alignItemsAtEnd
        keyboardShouldPersistTaps="handled"
        // A manual contentInset would zero UIKit's header inset and its scroll-edge region.
        contentInsetAdjustmentBehavior="automatic"
        contentInsetStartAdjustment={listTopInset}
        contentContainerStyle={{ padding: 16 }}
        ListEmptyComponent={
          <Text className="py-6 text-center text-foreground-muted">
            {taskId
              ? "Messages for this task will appear here."
              : `Ask ${title} for anything. It answers here and starts work in its own threads.`}
          </Text>
        }
        ListFooterComponent={
          !taskId && session.activity ? (
            <GoatBotActivityBubble text={session.activity.text} />
          ) : null
        }
      />
      <Animated.View
        className="gap-2 border-t border-border px-4 pt-2"
        style={composerPaddingStyle}
      >
        <GoatBotAttachmentStrip
          environmentId={session.historyEnvironmentId}
          attachments={attachments}
          onRemove={removeAttachment}
        />
        <View className="flex-row items-end gap-2">
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
            className="flex-1 px-3 py-2 text-foreground"
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
              className="items-center justify-center"
              style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: outgoingColor }}
            >
              <Text className="text-xl font-semibold text-white">↑</Text>
            </View>
          </Pressable>
        </View>
      </Animated.View>
    </KeyboardAvoidingView>
  );
}
