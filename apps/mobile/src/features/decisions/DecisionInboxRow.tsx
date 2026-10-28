import { useAtomValue } from "@effect/atom-react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { decisionInbox } from "../../state/threads";

export function DecisionInboxRow(props: { readonly onPress: () => void }) {
  const summary = useAtomValue(decisionInbox.summaryAtom);
  // Items a parent agent is handling stay reachable, without counting as waiting on you.
  if (summary.total === 0) return null;
  const label =
    summary.count > 0
      ? `${summary.count} decision${summary.count === 1 ? "" : "s"} waiting`
      : `${summary.total} with agents`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={props.onPress}
      className="min-h-12 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
    >
      <View className="min-w-0 flex-1">
        <Text className="font-goat-bold text-sm text-foreground">{label}</Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
    </Pressable>
  );
}
