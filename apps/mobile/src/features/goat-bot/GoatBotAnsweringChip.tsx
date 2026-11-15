import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import type { ChannelQuestionId, ChannelTaskId } from "@goat/contracts";
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";

/** The question a typed message answers, from its card's Something else. */
export interface GoatBotAnswerTarget {
  readonly rowId: string;
  readonly taskId: ChannelTaskId;
  /** Absent from servers that do not name a task's questions. */
  readonly questionId?: ChannelQuestionId;
  readonly question: string;
}

/**
 * Which question the message box answers, until sent, stopped, replaced, or its question closes or
 * the conversation changes, so a later message never goes to that task. Rows are null while
 * nothing can be sent (a reconnect showing a saved reference): the hold waits for them.
 */
export function useGoatBotAnswering(rows: ReadonlyArray<GoatBotRow> | null, conversation: string) {
  const [held, setHeld] = useState<{
    readonly target: GoatBotAnswerTarget;
    readonly conversation: string;
  } | null>(null);
  const asked =
    held === null || rows === null ? undefined : rows.find((row) => row.id === held.target.rowId);
  if (
    held !== null &&
    (held.conversation !== conversation ||
      (rows !== null && (asked?.kind !== "bot" || asked.options.length === 0)))
  ) {
    setHeld(null);
  }
  const target = held !== null && held.conversation === conversation ? held.target : null;
  /** Another question's Something else: its own target, or none for a question no task asked. */
  const start = useCallback(
    (next: GoatBotAnswerTarget | null) =>
      setHeld(next === null ? null : { target: next, conversation }),
    [conversation],
  );
  const stop = useCallback(() => setHeld(null), []);
  return { target, start, stop };
}

/** Above the message box while it answers a question: what it answers, and a way out. */
export function GoatBotAnsweringChip(props: {
  readonly target: GoatBotAnswerTarget;
  /** Files are in the box; an answer cannot carry them. */
  readonly blockedByFiles: boolean;
  readonly onStop: () => void;
}) {
  const label = useScaledTextRole("label");
  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-1 self-start rounded-full border border-border pl-3">
        <Text
          numberOfLines={1}
          accessibilityLabel={`Answering: ${props.target.question}`}
          className="shrink text-foreground-muted"
          style={label}
        >
          Answering “{props.target.question}”
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop answering"
          onPress={props.onStop}
          className="min-h-[44px] min-w-[44px] items-center justify-center"
        >
          <SymbolView name="xmark" size={11} tintColorClassName="accent-icon-muted" />
        </Pressable>
      </View>
      {props.blockedByFiles ? (
        <Text accessibilityRole="alert" className="text-danger-foreground" style={label}>
          An answer can't carry files. Remove them to send it.
        </Text>
      ) : null}
    </View>
  );
}
