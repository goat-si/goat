import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";

/** Android hides the native header, so the chip that opens the bot's home sits above the chat. */
export function MobileBotHomeChip(props: {
  readonly botName: string;
  readonly face?: ReactNode;
  readonly onOpen: () => void;
}) {
  return (
    <View className="flex-row items-center px-4">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.botName}
        accessibilityHint={`Opens ${props.botName}'s home`}
        onPress={props.onOpen}
        className="min-h-[44px] justify-center"
      >
        <View className="flex-row items-center gap-1.5 rounded-full bg-goat-bot-message py-1 pl-1 pr-3">
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {props.face}
          </View>
          <Text className="font-semibold text-foreground">{props.botName}</Text>
          <SymbolView name="chevron.down" size={11} tintColorClassName="accent-icon-muted" />
        </View>
      </Pressable>
    </View>
  );
}
