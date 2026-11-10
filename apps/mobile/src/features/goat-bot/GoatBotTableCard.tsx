import { useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";

/** The width a table column gets before the card scrolls sideways. */
const COLUMN_WIDTH = 148;
/** The chat's side padding; the card may use the rest of the row. */
const ROW_INSET = 32;

/**
 * A table from a bot reply in its own card: wide tables scroll sideways inside the card instead of
 * squeezing their columns, and the table can be copied as the Markdown it was written in.
 */
export function GoatBotTableCard(props: {
  /** The table drawn by the chat's Markdown renderer, so its links and selection keep working. */
  readonly children: ReactNode;
  readonly columns: number;
  /** The table as the bot wrote it, for copying. */
  readonly markdown: string;
}) {
  const label = useScaledTextRole("label");
  const available = useWindowDimensions().width - ROW_INSET;
  const width = Math.max(available - 28, props.columns * COLUMN_WIDTH);
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = async () => {
    const done = await tryCopyTextWithHaptic(props.markdown, { target: "table" });
    AccessibilityInfo.announceForAccessibility(done ? "Table copied" : "Couldn't copy the table");
    if (!done) return;
    setCopied(true);
    if (reset.current !== null) clearTimeout(reset.current);
    reset.current = setTimeout(() => setCopied(false), 2000);
  };
  return (
    <View
      className="self-stretch bg-goat-bot-message"
      style={{ borderRadius: 18, paddingVertical: 9, overflow: "hidden" }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={width > available}
        contentContainerStyle={{ paddingHorizontal: 14 }}
      >
        <View style={{ width }}>{props.children}</View>
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copied ? "Copied" : "Copy table"}
        accessibilityHint="Copies the table as text"
        onPress={() => void copy()}
        className="min-h-[44px] min-w-[44px] flex-row items-center gap-1.5 self-start"
        style={{ paddingHorizontal: 14 }}
      >
        <SymbolView
          name={copied ? "checkmark" : "doc.on.doc"}
          size={13}
          tintColorClassName="accent-icon-muted"
        />
        <Text className="text-foreground-muted" style={label}>
          {copied ? "Copied" : "Copy table"}
        </Text>
      </Pressable>
    </View>
  );
}
