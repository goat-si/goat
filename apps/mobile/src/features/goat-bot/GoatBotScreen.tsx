import { MemoryReportLink } from "../settings/SettingsMemoryRouteScreen";
import { LegendList } from "@legendapp/list/react-native";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { goatBotReceiptLabel, type GoatBotRow } from "@goat/client-runtime/goatBot";
import { memo, useCallback, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { useReplying } from "./useReplying";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useMobileGoatBotHomeSettings } from "./useMobileGoatBotHomeSettings";
import { useMobileGoatBotSession } from "./useMobileGoatBotSession";
import { GoatBotBubble, GoatBotTypingIndicator } from "./GoatBotBubble";
import { GoatBotDayStamp } from "./GoatBotDayStamp";
import { GoatBotLinkedText } from "./GoatBotLinkedText";
import { GOAT_BOT_BUBBLE_COLORS, goatBotBubbleLayout } from "./goatBotBubbleStyle";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";

type ThreadSelection = Pick<EnvironmentThreadShell, "environmentId" | "id">;
const rowKey = (row: GoatBotRow) => row.id;
const receiptTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const availabilityCopy = {
  ready: "Answers here, works in its own threads",
  connecting: "Connecting to GOAT Bot…",
  home_offline: "GOAT Bot’s computer is offline.",
  offline: "GOAT Bot's computer is offline. Messages will be available when it reconnects.",
  unsupported: "Update the server to use GOAT Bot here.",
  permission: "This connection does not have permission to message GOAT Bot.",
  legacy_active: "Your global agent is still working. Check again when it finishes.",
  error: "Couldn't reach GOAT Bot",
};

type GoatBotTaskRow = Extract<GoatBotRow, { kind: "task" }>;
const SUMMARY_LINES = 4;
/** About four lines of body text in a card at its narrowest. */
const SUMMARY_CHARS = 160;

/** A piece of work GOAT Bot started; remote work names its machine and waits for it to connect. */
function GoatBotTaskCard(props: {
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
          accessibilityLabel={`${card.title}. ${card.statusLabel}.${card.attentionLabel ? ` ${card.attentionLabel}.` : ""}${card.continuationLabel ? ` ${card.continuationLabel}.` : ""} ${(card.evidenceLabels ?? []).join(". ")} ${action}`}
          disabled={target.kind !== "thread" || unreachableHost !== null}
          onPress={() => {
            if (target.kind === "thread" && unreachableHost === null)
              props.onSelectThread({ environmentId: target.environmentId, id: target.threadId });
          }}
          className="gap-1"
        >
          <Text className="text-xs" style={{ color: textColor, opacity: 0.7 }}>
            {card.statusLabel}
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
            <GoatBotTaskSummary summary={card.summary} textColor={textColor} />
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
function GoatBotTaskSummary(props: { readonly summary: string; readonly textColor: string }) {
  const bodyText = useScaledTextRole("body");
  const [expanded, setExpanded] = useState(false);
  // Counted from the text: line metrics under numberOfLines differ between iOS and Android.
  const long =
    props.summary.length > SUMMARY_CHARS || props.summary.split("\n").length > SUMMARY_LINES;
  return (
    <View className="gap-0.5">
      <Text
        numberOfLines={expanded ? undefined : SUMMARY_LINES}
        style={{ color: props.textColor, ...bodyText }}
      >
        <GoatBotLinkedText text={props.summary} />
      </Text>
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
  readonly onSend: (answer: string) => boolean;
  readonly onRetry: (key: string) => void;
  readonly onSelectThread: (thread: ThreadSelection) => void;
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
  const layout = goatBotBubbleLayout(row.groupPosition);
  if (row.kind === "task") {
    return (
      <View style={{ marginTop: layout.marginTop, alignItems: "flex-start" }}>
        <GoatBotTaskCard card={row.card} onSelectThread={props.onSelectThread} tail={layout.tail} />
      </View>
    );
  }
  if (row.kind === "user") {
    const delivery = row.delivery;
    const receipt = goatBotReceiptLabel(delivery, receiptTime);
    return (
      <View className="items-end gap-1" style={{ marginTop: layout.marginTop }}>
        <GoatBotBubble side="out" tail={layout.tail}>
          {(textColor) => (
            <Text selectable style={{ color: textColor, ...bodyText }}>
              {row.text}
            </Text>
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
          </View>
        ) : null}
      </View>
    );
  }
  return (
    <View className="items-start gap-1" style={{ marginTop: layout.marginTop }}>
      {row.proactive && row.firstInGroup ? (
        <Text className="text-xs text-foreground-muted">GOAT Bot · Update</Text>
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
            <Text
              selectable
              className={row.tone === "failure" ? "text-danger-foreground" : undefined}
              style={row.tone === "failure" ? bodyText : { color: textColor, ...bodyText }}
              accessibilityLabel={row.tone === "failure" ? `Failed: ${row.text}` : undefined}
            >
              <GoatBotLinkedText text={row.text} />
            </Text>
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
              onPress={() => props.onSend(answer)}
              className="rounded-full border px-3 py-2"
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

export function GoatBotScreen(props: {
  readonly visible: boolean;
  readonly onSelectThread?: (thread: ThreadSelection) => void;
}) {
  const session = useMobileGoatBotSession(props.visible);
  const homeSettings = useMobileGoatBotHomeSettings();
  const moveTarget = homeSettings.moveTarget;
  const { themeAppearance } = useAppearancePreferences();
  const bodyText = useScaledTextRole("body");
  const outgoingColor = GOAT_BOT_BUBBLE_COLORS[themeAppearance].out;
  const selectDetail = useSelectWorkspaceDetail();
  const selectThread = useCallback(
    (thread: ThreadSelection) =>
      selectDetail({
        name: "Thread",
        params: { environmentId: String(thread.environmentId), threadId: String(thread.id) },
      }),
    [selectDetail],
  );
  const onSelectThread = props.onSelectThread ?? selectThread;
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const bottomInset = keyboardVisible ? 8 : Math.max(8, insets.bottom);
  const topInset = Platform.OS === "ios" ? insets.top : 0;
  const hasBanner = session.availability !== "ready";
  const [text, setText] = useState("");
  const [inputHeight, setInputHeight] = useState(44);
  const replying = useReplying(session.replyingSince, props.visible);
  const renderItem = useCallback(
    ({ item }: { item: GoatBotRow }) => (
      <GoatBotTimelineRow
        row={item}
        canSend={session.canSend}
        onSend={session.onSend}
        onRetry={session.onRetryInput}
        onSelectThread={onSelectThread}
      />
    ),
    [session.canSend, session.onSend, session.onRetryInput, onSelectThread],
  );
  const send = () => {
    if (session.onSend(text)) {
      setText("");
      setInputHeight(44);
    }
  };
  return (
    <KeyboardAvoidingView className="flex-1 bg-screen" automaticOffset behavior="height">
      {hasBanner ? (
        <View
          accessibilityRole="alert"
          className="gap-2 border-b border-border px-4 py-3"
          style={{ paddingTop: topInset + 12 }}
        >
          <Text className="text-sm text-foreground-muted">
            {session.availability === "home_offline"
              ? session.homeKnown
                ? `GOAT Bot runs on ${session.homeLabel}, which isn't connected.`
                : `GOAT Bot's home (${session.homeLabel}) isn't a computer this app knows.`
              : session.availability === "error"
                ? (session.error ?? availabilityCopy.error)
                : availabilityCopy[session.availability]}
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
              <Text className="text-sm text-foreground">Move GOAT Bot to {moveTarget.label}</Text>
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
      {homeSettings.error ? (
        <Text accessibilityRole="alert" className="px-4 py-2 text-sm text-danger-foreground">
          {homeSettings.error}
        </Text>
      ) : null}
      <NativeScrollViewMarker style={{ flex: 1 }}>
        <LegendList
          style={{ flex: 1 }}
          data={session.rows}
          keyExtractor={rowKey}
          renderItem={renderItem}
          maintainScrollAtEnd
          alignItemsAtEnd
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="never"
          contentInset={{ top: hasBanner ? 0 : topInset }}
          contentContainerStyle={{ padding: 16 }}
          ListEmptyComponent={
            <Text className="py-6 text-center text-foreground-muted">
              Ask GOAT Bot for anything. It answers here and starts work in its own threads.
            </Text>
          }
          ListFooterComponent={replying ? <GoatBotTypingIndicator /> : null}
        />
      </NativeScrollViewMarker>
      <View
        className="flex-row items-end gap-2 border-t border-border px-4 pt-2"
        style={{ paddingBottom: bottomInset }}
      >
        <TextInput
          accessibilityLabel="Message GOAT Bot"
          placeholder="Message GOAT Bot"
          placeholderTextColorClassName="accent-placeholder"
          value={text}
          onChangeText={setText}
          multiline
          editable={session.canSend}
          onContentSizeChange={(event) =>
            setInputHeight(Math.min(160, Math.max(44, event.nativeEvent.contentSize.height)))
          }
          className="flex-1 px-3 py-2 text-foreground"
          style={{
            height: inputHeight,
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
          disabled={!session.canSend || !text.trim()}
          onPress={send}
          className="items-center justify-center"
          style={{
            width: 44,
            height: 44,
            opacity: session.canSend && text.trim() ? 1 : 0.45,
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
    </KeyboardAvoidingView>
  );
}
