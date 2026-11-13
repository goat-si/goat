import { MemoryReportLink } from "../settings/SettingsMemoryRouteScreen";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  goatBotAccent,
  goatBotEventSubjectSpan,
  goatBotName,
  goatBotNotesRefreshKey,
  hasGoatBotMarkdown,
  type GoatBotAccent,
  type GoatBotReplyRepository,
  type GoatBotRow,
} from "@goat/client-runtime/goatBot";
import {
  type BotProfile,
  ChannelQuestionId,
  ChannelTaskId,
  type EnvironmentId,
  type GoatBotEventSubject,
} from "@goat/contracts";
import { HeaderHeightContext } from "@react-navigation/elements";
import { StackActions, useNavigation } from "@react-navigation/native";
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  Text,
  TextInput,
  type TextInputInstance,
  View,
  useWindowDimensions,
} from "react-native";
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
import { GoatBotHeroFace } from "./GoatBotHeroFace";
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
import {
  GoatBotAnsweringChip,
  type GoatBotAnswerTarget,
  useGoatBotAnswering,
} from "./GoatBotAnsweringChip";
import { GoatBotModelPill } from "./GoatBotModelPill";
import { goatBotModelPillMenu } from "./goatBotModelPillMenu";
import { GoatBotReplyCards } from "./GoatBotReplyCards";
import { useMobileBotEditing } from "./MobileNewBotNameRow";
import { chatFilesScope, GoatBotFilesProvider, GoatBotReplyFiles } from "./GoatBotReplyFiles";
import { useBotFileOpener } from "./MobileBotFileViewer";
import { GoatBotStepsAbove, GoatBotStepsMark } from "./GoatBotStepsMark";
import { useGoatBotActivityMarks } from "./useGoatBotActivityMarks";
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
import { type MobileBotHomeFocus, useGoatBotEventTargets } from "./useGoatBotEventTargets";
import { goatBotChatRows } from "./goatBotChatRows";
import { goatBotComposerBottomPadding, goatBotInputMaxHeight } from "./goatBotComposerInsets";
import { GOAT_BOT_LIST_PADDING, goatBotFooterInView } from "./goatBotListEnd";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { MobileBotWork } from "./MobileBotWork";
import { MobileDeletedBotBanner } from "./MobileDeletedBotBanner";
import { mobileGoatBotMemberPicture } from "./mobileGoatBotMembers";
import { availabilityCopy } from "./goatBotAvailabilityCopy";

type ThreadSelection = Pick<EnvironmentThreadShell, "environmentId" | "id">;
const rowKey = (item: GoatBotChatItem) => item.id;
type TaskRow = Extract<GoatBotRow, { kind: "task" }>;
type ListMetrics = Parameters<typeof goatBotFooterInView>[0];

export const GoatBotTimelineRow = memo(function GoatBotTimelineRow(props: {
  readonly row: GoatBotRow;
  readonly canSend: boolean;
  /** Sends an answer, to the task whose question offered it when the row names one. */
  readonly onSend: (
    answer: string,
    taskId?: ChannelTaskId,
    questionId?: ChannelQuestionId,
  ) => boolean;
  /** A question's Something else: the message box answers it, or takes a plain message. */
  readonly onSomethingElse?: ((target: GoatBotAnswerTarget | null) => void) | undefined;
  readonly onRetry: (key: string) => void;
  readonly onDiscard?: (key: string) => void;
  readonly onSelectThread: (thread: ThreadSelection) => void;
  readonly onSelectTask?: (taskId: ChannelTaskId) => void;
  /** Where an event line's routine or task opens; undefined leaves the line plain. */
  readonly onOpenEvent?: ((subject: GoatBotEventSubject) => (() => void) | undefined) | undefined;
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
    const subject = row.subject;
    const span = goatBotEventSubjectSpan(row);
    const open =
      subject === undefined || span === undefined ? undefined : props.onOpenEvent?.(subject);
    if (subject === undefined || span === undefined || open === undefined) {
      return (
        <Text accessibilityRole="text" className="my-2 text-center text-xs text-foreground-muted">
          {row.text}
        </Text>
      );
    }
    // The whole line is the target, so a thumb need not find the name in small type.
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${row.text}. Open ${subject.kind} ${subject.name}`}
        onPress={open}
        className="min-h-[44px] justify-center"
      >
        <Text className="text-center text-xs text-foreground-muted">
          {span.before}
          <Text className="text-foreground underline">{span.name}</Text>
          {span.after}
        </Text>
      </Pressable>
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
          accent={props.accent}
          onPick={(answer) =>
            props.onSend(
              answer,
              row.answerTaskId === undefined ? undefined : ChannelTaskId.make(row.answerTaskId),
              row.answerQuestionId === undefined
                ? undefined
                : ChannelQuestionId.make(row.answerQuestionId),
            )
          }
          onSomethingElse={
            props.onSomethingElse
              ? () =>
                  props.onSomethingElse?.(
                    row.answerTaskId === undefined
                      ? null
                      : {
                          rowId: row.id,
                          taskId: ChannelTaskId.make(row.answerTaskId),
                          ...(row.answerQuestionId === undefined
                            ? {}
                            : { questionId: ChannelQuestionId.make(row.answerQuestionId) }),
                          question: row.text,
                        },
                  )
              : undefined
          }
        >
          {renderText(row.text)}
          {memory}
        </GoatBotQuestionCard>
      ) : (
        <GoatBotReplyCards text={row.text} renderText={renderText} footer={memory} />
      )}
      <GoatBotReplyFiles text={row.text} />
      <GoatBotBotCaption at={row.createdAt} groupPosition={row.groupPosition} />
    </View>
  );
});

export function GoatBotScreen(props: {
  readonly visible: boolean;
  /** False while the app is in the background, where GOAT Bot's steps are not read. */
  readonly foreground?: boolean;
  /** Focused and the app active: what the screen shows has been seen. */
  readonly seen?: boolean;
  readonly taskId?: ChannelTaskId;
  /** The title the screen that opened this task carried, for a task the list no longer holds. */
  readonly taskTitle?: string | undefined;
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
  const conversation = member
    ? { environmentId: member.environmentId, threadId: member.sessionThreadId }
    : undefined;
  const mainName = goatBotName(props.main ?? null);
  const session = useMobileGoatBotSession(props.visible, props.taskId ?? null, member);
  const title = goatBotName(member ?? props.main ?? null);
  const editing = useMobileBotEditing(member, mainName);
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
    (taskId: ChannelTaskId, taskTitle?: string) =>
      navigation.dispatch(
        StackActions.push("GoatBot", {
          taskId,
          ...(member ? { botId: member.botId } : {}),
          ...(taskTitle ? { taskTitle } : {}),
        }),
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
  // An event line opens the home on its routine or listed task, or a task that left the list on its
  // own screen; a routine that is gone leaves the line plain.
  const events = useGoatBotEventTargets(member);
  const landEvent = events.land;
  const [homeFocus, setHomeFocus] = useState<(MobileBotHomeFocus & { seq: number }) | null>(null);
  const onOpenEvent = useCallback(
    (subject: GoatBotEventSubject) => {
      if (taskId || (subject.kind === "task" && !session.supportsTaskThreads)) return undefined;
      const landing = landEvent(subject);
      if (landing === null) return undefined;
      if (landing === "task-screen") return () => onSelectTask(ChannelTaskId.make(subject.id));
      return () => {
        setHomeFocus((current) => ({ ...landing, seq: (current?.seq ?? 0) + 1 }));
        setHomeOpen(true);
      };
    },
    [taskId, session.supportsTaskThreads, landEvent, onSelectTask],
  );
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
  // The "New" line and its pill belong to a bot's chat, whose visits the route records.
  const unread = useGoatBotUnread(visibleRows, taskId !== undefined ? null : props.readSnapshot);
  // The chat owns its file opener, so an image shown over it also pauses reading the steps.
  const opener = useBotFileOpener(
    session.historyEnvironmentId,
    title,
    chatFilesScope(session.historyEnvironmentId, session.threadId),
  );
  const {
    placement,
    opened,
    toggle: toggleSteps,
  } = useGoatBotActivityMarks({
    chat: session,
    taskId: taskId ?? null,
    rows: visibleRows,
    reading: props.visible && props.foreground !== false && !opener.covered,
  });
  const listRef = useRef<LegendListRef>(null);
  const { clear: clearUnread } = unread;
  const { onAnswer: answer } = session;
  const onAnswer = useCallback(
    (text: string, answerTask?: ChannelTaskId, questionId?: ChannelQuestionId) => {
      const sent = answer(text, answerTask, questionId);
      if (sent) clearUnread();
      return sent;
    },
    [answer, clearUnread],
  );
  // Something else hands a question to the message box, which then answers it until sent.
  const inputRef = useRef<TextInputInstance>(null);
  const answering = useGoatBotAnswering(
    visibleRows,
    JSON.stringify([member?.botId ?? null, taskId ?? null]),
  );
  const startAnswering = answering.start;
  const onSomethingElse = useCallback(
    (target: GoatBotAnswerTarget | null) => {
      // The row used decides: its question, or none for a question no task asked.
      startAnswering(target);
      inputRef.current?.focus();
    },
    [startAnswering],
  );
  const [inputHeight, setInputHeight] = useState(44);
  const inputMaxHeight = goatBotInputMaxHeight(useWindowDimensions().height);
  const eventsKey = events.key;
  const focusDivider = unread.focusDivider;
  const listExtraData = useMemo(
    () => ({ accent, eventsKey, focusDivider, placement, opened }),
    [accent, eventsKey, focusDivider, placement, opened],
  );
  const renderItem = useCallback(
    ({ item }: { item: GoatBotChatItem }) => {
      if (item.kind === "unread")
        return (
          <GoatBotUnreadDividerRow focus={unread.focusDivider} onFocused={unread.dividerFocused} />
        );
      return (
        <GoatBotStepsAbove
          mark={placement.beforeRow.get(item.id)}
          opened={opened}
          onToggle={toggleSteps}
        >
          <GoatBotTimelineRow
            row={item}
            canSend={session.canSend}
            onSend={onAnswer}
            onSomethingElse={onSomethingElse}
            onRetry={session.onRetryInput}
            onDiscard={session.onDiscardInput}
            onSelectThread={onSelectThread}
            onSelectTask={!taskId && session.supportsTaskThreads ? onSelectTask : undefined}
            onOpenEvent={onOpenEvent}
            environmentId={session.historyEnvironmentId}
            botName={title}
            botEmoji={botEmoji}
            accent={accent}
          />
        </GoatBotStepsAbove>
      );
    },
    [
      unread.focusDivider,
      unread.dividerFocused,
      placement,
      opened,
      toggleSteps,
      session.canSend,
      onAnswer,
      onSomethingElse,
      session.onRetryInput,
      session.onDiscardInput,
      onSelectThread,
      onSelectTask,
      taskId,
      onOpenEvent,
      session.supportsTaskThreads,
      session.historyEnvironmentId,
      title,
      botEmoji,
      accent,
    ],
  );
  // Photos still being read after the picker closed; they join the message when they arrive.
  const [intake, setIntake] = useState(0);
  // Where the caret goes once the home sheet has gone, after a request filled the box from it.
  const focusOnDismiss = useRef<number | null>(null);
  // Edit bot from the home sheet opens once the sheet has gone.
  const editOnDismiss = useRef(false);
  const focusInput = (caret: number) => {
    inputRef.current?.focus();
    inputRef.current?.setSelection(caret, caret);
  };
  const sheetGone = () => {
    const caret = focusOnDismiss.current;
    focusOnDismiss.current = null;
    if (caret !== null) focusInput(caret);
    if (editOnDismiss.current) {
      editOnDismiss.current = false;
      editing.openEdit?.();
    }
  };
  // oxlint-disable-next-line goat/react-effect-budget -- Android has no sheet dismissal event: focus the box once the closed sheet and the drafted text have committed.
  useEffect(() => {
    if (Platform.OS === "android" && !homeOpen) sheetGone();
  });
  // A drafted request (New routine, Ask to change or forget) fills only an empty message box; the
  // caller keeps its sheet and wording when the box is taken.
  const draft = (request: string) => {
    if (text.trim().length > 0 || attachments.length > 0 || intake > 0) {
      Alert.alert(
        "Your message is still in the box",
        "Send or clear it, then try again to start this request.",
      );
      return false;
    }
    setText(request);
    // A drafted request is its own message, never an answer to a question.
    answering.stop();
    if (homeOpen) focusOnDismiss.current = request.length;
    else focusInput(request.length);
    return true;
  };
  const answerBlockedByFiles = answering.target !== null && (attachments.length > 0 || intake > 0);
  const send = () => {
    // An answer to a question goes to its task as words alone.
    const target = answering.target;
    if (target !== null) {
      if (answerBlockedByFiles) return;
      if (onAnswer(text.trim(), target.taskId, target.questionId)) {
        answering.stop();
        setText("");
        setInputHeight(44);
      }
      return;
    }
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
  const canSubmit =
    session.canSend &&
    (answering.target === null ? hasDraft : text.trim().length > 0 && !answerBlockedByFiles);
  const modelMenu = goatBotModelPillMenu(memberModelMenu, mainModelMenu, member !== null);
  const chatTasks = useMemo(
    () =>
      taskId === undefined && session.supportsTaskThreads
        ? session.rows.flatMap((row) => (row.kind === "task" ? [row.card] : []))
        : [],
    [taskId, session.supportsTaskThreads, session.rows],
  );
  // A reply still arriving asks for no listing until it has finished.
  const fileReplies = useMemo(
    () =>
      session.rows.flatMap((row) =>
        row.kind === "bot" ? [{ ...row, streaming: session.streamingReplyIds.has(row.id) }] : [],
      ),
    [session.rows, session.streamingReplyIds],
  );
  return (
    <GoatBotFilesProvider
      environmentId={session.historyEnvironmentId}
      threadId={session.threadId}
      replies={fileReplies}
      opener={opener}
    >
      <KeyboardAvoidingView className="flex-1 bg-screen" automaticOffset behavior="height">
        {Platform.OS === "ios" ? (
          <GoatBotHeaderFace
            activity={session.activity ?? null}
            title={title}
            emoji={botEmoji}
            accent={accent}
            onPress={taskId ? undefined : openHome}
            conversation={conversation}
          />
        ) : null}
        <View style={{ paddingTop: topInset }}>
          <MobileBotWork
            taskId={taskId}
            open={homeOpen}
            onOpenChange={setHomeOpen}
            focus={homeFocus}
            // iOS reports the sheet's dismissal; Android is handled once the closed sheet commits.
            onDismissed={sheetGone}
            heroFace={
              <GoatBotHeroFace
                activity={session.activity ?? null}
                emoji={botEmoji}
                accent={accent}
                conversation={conversation}
              />
            }
            chipFace={
              Platform.OS === "android" ? (
                <GoatBotChipFace
                  activity={session.activity ?? null}
                  emoji={botEmoji}
                  accent={accent}
                  conversation={conversation}
                />
              ) : null
            }
            visible={props.visible}
            seen={props.seen ?? props.visible}
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
            onDraft={session.canSend ? draft : undefined}
            onEditBot={
              editing.openEdit === undefined
                ? undefined
                : () => {
                    editOnDismiss.current = true;
                    setHomeOpen(false);
                  }
            }
            notesRefreshKey={goatBotNotesRefreshKey(session.rows)}
            workRevision={session.workRevision}
            chatTasks={chatTasks}
            taskCardInfo={taskCard?.card ?? null}
            taskTitle={props.taskTitle}
            taskCard={
              taskCard ? (
                <GoatBotTaskRow card={taskCard.card} statusHidden onSelectThread={onSelectThread} />
              ) : null
            }
          />
        </View>
        {member?.state === "deleted" ? (
          <MobileDeletedBotBanner member={member} onRestore={props.onRestoreMember} />
        ) : null}
        {editing.editSheet}
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
            // the "New" line must learn when to take VoiceOver focus, and an event line where its
            // routine or task now opens.
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
              placement.trailing || (!taskId && session.activity) ? (
                <View>
                  {placement.trailing ? (
                    <GoatBotStepsMark
                      mark={placement.trailing}
                      opened={opened}
                      onToggle={toggleSteps}
                    />
                  ) : null}
                  {!taskId && session.activity ? (
                    // Only the progress line is measured: its motion runs while it shows.
                    <View
                      testID="goat-bot-progress-line"
                      onLayout={(event) =>
                        measureList({ footerHeight: event.nativeEvent.layout.height })
                      }
                    >
                      <GoatBotActivityLine
                        activity={session.activity}
                        botName={title}
                        emoji={botEmoji}
                        accent={accent}
                        inView={footerInView}
                      />
                    </View>
                  ) : null}
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
          {editing.nameRow}
          {answering.target !== null ? (
            <GoatBotAnsweringChip
              target={answering.target}
              blockedByFiles={answerBlockedByFiles}
              onStop={answering.stop}
            />
          ) : null}
          {/* Two rows on a phone: the field, then attach, model and send under the thumb. */}
          <TextInput
            ref={inputRef}
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
                onIntake={(change) => setIntake((count) => count + change)}
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
    </GoatBotFilesProvider>
  );
}
