import type { ReactNode } from "react";
import { View } from "react-native";

/**
 * The composer and the status lines above it (offline, cloud notices). The feed's bottom inset
 * is this whole slot's height: measuring only the composer let those lines cover the feed.
 */
export function ComposerSlot(props: {
  readonly hidden: boolean;
  readonly onHeight: (height: number) => void;
  readonly children: ReactNode;
}) {
  return (
    <View
      style={props.hidden ? { display: "none" } : undefined}
      onLayout={(event) => props.onHeight(event.nativeEvent.layout.height)}
    >
      {props.children}
    </View>
  );
}
