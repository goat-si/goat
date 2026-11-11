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
 * Which question the message box answers. It lets go when the person sends or stops answering,
 * and for good when the question closes, so a later message is never sent to that task.
 */
export function useGoatBotAnswering(rows: ReadonlyArray<GoatBotRow>) {
  const [target, setTarget] = useState<GoatBotAnswerTarget | null>(null);
  const asked = target === null ? undefined : rows.find((row) => row.id === target.rowId);
  if (target !== null && (asked?.kind !== "bot" || asked.options.length === 0)) setTarget(null);
  const start = useCallback((next: GoatBotAnswerTarget) => setTarget(next), []);
  const stop = useCallback(() => setTarget(null), []);
  return { target, start, stop };
}

/** Above the message box while it answers a question: what it answers, and a way out. */
export function GoatBotAnsweringChip(props: {
  readonly target: GoatBotAnswerTarget;
  readonly onStop: () => void;
}) {
  const label = useScaledTextRole("label");
  return (
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
  );
}
