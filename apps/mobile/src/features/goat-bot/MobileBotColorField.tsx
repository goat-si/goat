import { GOAT_BOT_COLORS, goatBotAccent, sameBotColor } from "@goat/client-runtime/goatBot";
import { Pressable, Text, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";

const OPTIONS: ReadonlyArray<{ readonly name: string; readonly value: string | null }> = [
  { name: "Neutral", value: null },
  ...GOAT_BOT_COLORS.map(({ name, value }) => ({ name, value })),
];

/**
 * A member bot's colour as named swatches, the same palette web offers. A check mark marks the
 * chosen one, so it never reads by colour alone.
 */
export function MobileBotColorField(props: {
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
  readonly disabled?: boolean;
}) {
  return (
    <View className="gap-2">
      <Text className="text-foreground">Color</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Bot color"
        className="flex-row flex-wrap gap-1"
      >
        {OPTIONS.map((option) => {
          const checked = sameBotColor(option.value, props.value);
          const accent =
            option.value === null ? null : goatBotAccent({ role: "member", color: option.value });
          return (
            <Pressable
              key={option.name}
              accessibilityRole="radio"
              accessibilityLabel={option.name}
              accessibilityState={{ checked, disabled: props.disabled === true }}
              disabled={props.disabled}
              onPress={() => props.onChange(option.value)}
              className="h-11 w-11 items-center justify-center"
            >
              <View
                className={`h-8 w-8 items-center justify-center rounded-full border ${checked ? "border-2 border-foreground" : "border-border"} ${accent ? "" : "bg-goat-person-message"}`}
                style={accent ? { backgroundColor: accent.background } : undefined}
              >
                {checked ? (
                  <SymbolView
                    name="checkmark"
                    size={14}
                    {...(accent
                      ? { tintColor: accent.foreground }
                      : { tintColorClassName: "accent-goat-person-message-foreground" })}
                  />
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
