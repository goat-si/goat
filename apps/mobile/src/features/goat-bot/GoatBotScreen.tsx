import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { GoatBotRow } from "@t3tools/client-runtime/goatBot";
import { memo, useCallback, useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useHomeThreadSelection } from "../home/home-thread-navigation";
import { useMobileGoatBotSession } from "./useMobileGoatBotSession";

type ThreadSelection = Pick<EnvironmentThreadShell, "environmentId" | "id">;
const rowKey = (row: GoatBotRow) => row.id;
const dayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});
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

const GoatBotTimelineRow = memo(function GoatBotTimelineRow(props: {
  readonly row: GoatBotRow;
  readonly canSend: boolean;
  readonly onSend: (answer: string) => boolean;
  readonly onRetry: (key: string) => void;
  readonly onSelectThread: (thread: ThreadSelection) => void;
}) {
  const { row } = props;
  if (row.kind === "day") {
    const date = new Date(row.at);
    return (
      <Text className="py-4 text-center text-xs text-foreground-muted">
        {Number.isNaN(date.getTime()) ? "" : dayFormatter.format(date)}
      </Text>
    );
  }
  if (row.kind === "task") {
    const { card } = row;
    const target = card.target;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${card.title}. ${card.statusLabel}. ${target.kind === "thread" ? "Open thread" : target.label}`}
        disabled={target.kind !== "thread"}
        onPress={() => {
          if (target.kind === "thread")
            props.onSelectThread({ environmentId: target.environmentId, id: target.threadId });
        }}
        className="my-2 max-w-[90%] gap-1 rounded-2xl border border-border bg-card p-3"
      >
        <Text
          className={
            card.tone === "danger"
              ? "text-xs text-danger-foreground"
              : "text-xs text-foreground-muted"
          }
        >
          {card.statusLabel}
          {card.attentionLabel ? ` · ${card.attentionLabel}` : ""}
        </Text>
        <Text className="font-semibold text-foreground">{card.title}</Text>
        {card.sourceLabel ? (
          <Text className="text-xs text-foreground-muted">{card.sourceLabel}</Text>
        ) : null}
        {card.summary ? (
          <Text numberOfLines={3} className="text-sm text-foreground">
            {card.summary}
          </Text>
        ) : null}
        <Text className="text-xs text-foreground-muted">
          {target.kind === "thread" ? "Open thread ↗" : target.label}
        </Text>
      </Pressable>
    );
  }
  if (row.kind === "user") {
    const delivery = row.delivery;
    const label =
      delivery.state === "sending"
        ? "Sending…"
        : delivery.state === "failed"
          ? (delivery.rejectionReason ?? "Not sent")
          : delivery.state === "read"
            ? "Read"
            : "Sent";
    return (
      <View className="my-1 items-end gap-1">
        <View className="max-w-[85%] rounded-2xl bg-user-bubble px-3 py-2">
          <Text selectable className="text-base text-user-bubble-foreground">
            {row.text}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Text className="text-xs text-foreground-muted">{label}</Text>
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
      </View>
    );
  }
  return (
    <View className="my-1 items-start gap-1">
      <View className="max-w-[85%] gap-1 rounded-2xl bg-card px-3 py-2">
        {row.firstInGroup ? (
          <Text className="text-xs font-semibold text-foreground-muted">GOAT Bot</Text>
        ) : null}
        {row.replyTo ? (
          <Text
            numberOfLines={2}
            className="border-l-2 border-border pl-2 text-xs text-foreground-muted"
          >
            {row.replyTo}
          </Text>
        ) : null}
        <Text
          selectable
          className={
            row.tone === "failure"
              ? "text-base text-danger-foreground"
              : "text-base text-foreground"
          }
        >
          {row.text}
        </Text>
      </View>
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
              className="rounded-xl border border-border px-3 py-2"
            >
              <Text className="text-sm text-foreground">{answer}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
});

/** One expiry timer; the replying dots never animate or continuously repaint. */
function useReplying(since: string | null, visible: boolean) {
  const [expiredFor, setExpiredFor] = useState<string | null>(null);
  const started = since === null ? Number.NaN : Date.parse(since);
  useEffect(() => {
    if (!visible || since === null || Number.isNaN(started)) return;
    const timer = setTimeout(
      () => setExpiredFor(since),
      Math.max(0, started + 90_000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [since, started, visible]);
  return visible && since !== null && !Number.isNaN(started) && expiredFor !== since;
}

export function GoatBotScreen(props: {
  readonly visible: boolean;
  readonly onSelectThread?: (thread: ThreadSelection) => void;
}) {
  const session = useMobileGoatBotSession(props.visible);
  const selectThread = useHomeThreadSelection();
  const onSelectThread = props.onSelectThread ?? selectThread;
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [inputHeight, setInputHeight] = useState(40);
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
      setInputHeight(40);
    }
  };
  return (
    <KeyboardAvoidingView
      className="flex-1 bg-screen"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {session.availability !== "ready" ? (
        <View accessibilityRole="alert" className="gap-2 border-b border-border px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            {session.availability === "home_offline"
              ? `GOAT Bot runs on ${session.homeLabel}. It will continue when that computer connects.`
              : session.availability === "error"
                ? (session.error ?? availabilityCopy.error)
                : availabilityCopy[session.availability]}
          </Text>
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
      <KeyboardAwareLegendList
        style={{ flex: 1 }}
        data={session.rows}
        keyExtractor={rowKey}
        renderItem={renderItem}
        maintainScrollAtEnd
        alignItemsAtEnd
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16 }}
        ListEmptyComponent={
          <Text className="py-6 text-center text-foreground-muted">
            Ask GOAT Bot for anything. It answers here and starts work in its own threads.
          </Text>
        }
        ListFooterComponent={
          replying ? (
            <Text
              accessibilityRole="text"
              accessibilityLabel="GOAT Bot is replying"
              className="self-start rounded-2xl bg-card px-4 py-2 text-foreground-muted"
            >
              ● ● ●
            </Text>
          ) : null
        }
      />
      <View
        className="flex-row items-end gap-2 border-t border-border px-4 pt-2"
        style={{ paddingBottom: Math.max(8, insets.bottom) }}
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
            setInputHeight(Math.min(160, Math.max(40, event.nativeEvent.contentSize.height)))
          }
          className="flex-1 rounded-2xl border border-border px-3 py-2 text-base text-foreground"
          style={{ height: inputHeight }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message"
          disabled={!session.canSend || !text.trim()}
          onPress={send}
          className="rounded-xl bg-user-bubble px-4 py-3"
          style={{ opacity: session.canSend && text.trim() ? 1 : 0.45 }}
        >
          <Text className="font-semibold text-user-bubble-foreground">Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
