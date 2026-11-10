import {
  presentTaskStatus,
  taskAttemptLabel,
  type BotWorkTask,
} from "@goat/client-runtime/goatBot";
import type { BotThreadRow, ChannelTaskId, EnvironmentId, ThreadId } from "@goat/contracts";
import * as Option from "effect/Option";
import { Pressable, Text, View } from "react-native";

import { Button } from "../../components/ui/Button";
import { useThreadDetail, useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { goatBotWithoutThreadLinks } from "./goatBotChatMarkdown";
import { GoatBotMarkdown } from "./GoatBotMarkdown";
import { MobileBotRemoteWork } from "./MobileBotRemoteWork";

type ThreadSelection = { readonly environmentId: EnvironmentId; readonly id: ThreadId };
const PEEK_MESSAGES = 20;
/** About eight lines of a message; the thread holds the rest. */
const PEEK_CARD_MAX_HEIGHT = 200;

/**
 * A task seen from the bot's home without leaving it: its state, the latest words of its work
 * thread, every thread it started, and the two ways out — the thread itself or the task's own
 * conversation, which keeps retry and the task's actions.
 */
export function MobileBotPeek(props: {
  readonly entry: BotWorkTask;
  readonly rows: ReadonlyArray<BotThreadRow>;
  /** Whether this phone is connected to the bot's machine, where its work threads live. */
  readonly connected: boolean;
  readonly machineLabel: string;
  readonly onBack: () => void;
  readonly onOpenThread: (thread: ThreadSelection) => void;
  readonly onOpenTask: (id: ChannelTaskId) => void;
}) {
  const { entry } = props;
  const label = useScaledTextRole("label");
  const { row } = entry;
  const first = entry.threads[0] ?? null;
  const attempt = taskAttemptLabel(row.task.generation);
  const status = presentTaskStatus(row.task.status, row.view.doneAt).label;
  const titleOf = (thread: { environmentId: EnvironmentId; threadId: ThreadId }) => {
    const coding = props.rows.find(
      (candidate) =>
        candidate.kind === "coding" &&
        candidate.environmentId === thread.environmentId &&
        candidate.threadId === thread.threadId,
    );
    return coding?.kind === "coding" && coding.title ? coding.title : "Work thread";
  };
  return (
    <View className="flex-1 gap-3 py-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Back to home. ${row.task.title}`}
        onPress={props.onBack}
        className="min-h-[44px] flex-row items-center gap-1 self-start rounded-full bg-goat-bot-message px-3"
      >
        <Text className="text-foreground">‹</Text>
        <Text numberOfLines={1} className="shrink font-semibold text-foreground">
          {row.task.title}
        </Text>
      </Pressable>
      <Text className="text-foreground-muted" style={label}>
        {[status, attempt, row.unread ? "Unread" : null, row.view.pinnedAt ? "Pinned" : null]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      {first !== null ? (
        <MobileBotPeekMessages
          key={first.environmentId + ":" + first.threadId}
          environmentId={first.environmentId}
          threadId={first.threadId}
          connected={props.connected}
          machineLabel={props.machineLabel}
        />
      ) : null}
      {entry.threads.length + entry.remote.length + entry.subagents.length > 0 ? (
        <View className="gap-1">
          <Text className="text-xs font-medium text-foreground-muted">Threads</Text>
          {entry.threads.map((thread) => (
            <Pressable
              key={thread.environmentId + ":" + thread.threadId}
              accessibilityRole="button"
              accessibilityLabel={`Open ${titleOf(thread)}`}
              className="min-h-[44px] justify-center"
              onPress={() =>
                props.onOpenThread({ environmentId: thread.environmentId, id: thread.threadId })
              }
            >
              <Text numberOfLines={1} className="text-foreground">
                {titleOf(thread)}
              </Text>
            </Pressable>
          ))}
          {entry.remote.map((item) => (
            <MobileBotRemoteWork
              key={item.childWorkId}
              item={item}
              onOpenThread={props.onOpenThread}
            />
          ))}
          {entry.subagents.map((agent) => (
            <Text key={agent.childWorkId} className="text-foreground-muted">
              {agent.host ?? agent.destinationHint ?? "Subagent"} · {agent.label}
            </Text>
          ))}
        </View>
      ) : null}
      <View className="mt-auto gap-2 pb-4">
        {first !== null ? (
          <Button
            label="Go to thread"
            tone="contrast"
            fullWidth
            onPress={() =>
              props.onOpenThread({ environmentId: first.environmentId, id: first.threadId })
            }
          />
        ) : null}
        <Button
          label="Open task"
          tone="secondary"
          fullWidth
          onPress={() => props.onOpenTask(row.task.taskId)}
        />
      </View>
    </View>
  );
}

/** The latest words of a work thread, or why there are none to show. */
function MobileBotPeekMessages(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly connected: boolean;
  readonly machineLabel: string;
}) {
  const target = { environmentId: props.environmentId, threadId: props.threadId };
  const detail = useThreadDetail(target);
  const items = useThreadVisibleTurnItems(target);
  const label = useScaledTextRole("label");
  // The work's own words; the instructions the bot handed the worker stay in the thread.
  const messages = items
    .filter(({ item }) => item.type === "assistant_message")
    .slice(-PEEK_MESSAGES);
  const hasData = Option.isSome(detail.data);
  const line = (text: string, danger = false) => (
    <Text className={danger ? "text-danger-foreground" : "text-foreground-muted"} style={label}>
      {text}
    </Text>
  );
  if (detail.status === "deleted") return line("This thread was deleted.");
  if (Option.isSome(detail.error) && !hasData)
    return line("Couldn't load this thread's messages.", true);
  if (!hasData) {
    return props.connected
      ? line("Loading messages…")
      : line(`Not connected. Messages show when ${props.machineLabel} reconnects.`);
  }
  return (
    <View className="gap-2">
      {!props.connected ? line("Offline · showing saved messages") : null}
      {messages.length === 0
        ? line("No messages yet.")
        : messages.map(({ item }) =>
            item.type === "assistant_message" ? (
              <View
                key={item.id}
                className="self-start overflow-hidden rounded-2xl bg-goat-bot-message px-3 py-2"
                style={{ maxWidth: "88%", maxHeight: PEEK_CARD_MAX_HEIGHT }}
              >
                <GoatBotMarkdown
                  text={goatBotWithoutThreadLinks(item.text)}
                  environmentId={props.environmentId}
                  onSelectThread={() => {}}
                />
              </View>
            ) : null,
          )}
    </View>
  );
}
