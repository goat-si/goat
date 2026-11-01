import type { ReactNode } from "react";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { GOAT_BOT_BUBBLE_COLORS, type BubbleSide } from "./goatBotBubbleStyle";

export function GoatBotBubble(props: {
  readonly side: BubbleSide;
  readonly tail: boolean;
  readonly children: ReactNode | ((textColor: string) => ReactNode);
  readonly maxWidth?: `${number}%`;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const colors = GOAT_BOT_BUBBLE_COLORS[themeAppearance];
  const backgroundColor = colors[props.side];
  return (
    <View
      style={{
        backgroundColor,
        borderRadius: 20,
        paddingHorizontal: 13,
        paddingVertical: 8,
        maxWidth: props.maxWidth ?? "78%",
      }}
    >
      {typeof props.children === "function"
        ? props.children(colors[`${props.side}Text`])
        : props.children}
      {props.tail ? (
        <Svg
          accessible={false}
          width={17}
          height={21}
          viewBox="0 0 17 21"
          style={{
            position: "absolute",
            bottom: -1,
            right: props.side === "out" ? -8 : undefined,
            left: props.side === "in" ? -8 : undefined,
            transform: props.side === "in" ? [{ scaleX: -1 }] : undefined,
          }}
        >
          <Path d="M0 0 C1 9 3 15 16 18 C10 21 3 18 0 13 Z" fill={backgroundColor} />
        </Svg>
      ) : null}
    </View>
  );
}

export function GoatBotTypingIndicator() {
  return (
    <View accessibilityRole="text" accessibilityLabel="GOAT Bot is replying" className="self-start">
      <GoatBotBubble side="in" tail>
        {(textColor) => (
          <View className="flex-row items-center justify-center" style={{ minHeight: 40, gap: 2 }}>
            {[0, 1, 2].map((dot) => (
              <View
                key={dot}
                style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: textColor }}
              />
            ))}
          </View>
        )}
      </GoatBotBubble>
    </View>
  );
}
