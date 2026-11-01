import { BRAND_CHANNEL_LABEL, type BrandChannel } from "@goat/shared/brandChannels";
import { Platform, View } from "react-native";

import { AppText as Text } from "./ui/AppText";
import { useAndroidControlSizing } from "./ui/useAndroidControlSizing";

/** Release-channel identity stays independent of the selected palette. */
export function BrandChannelPill(props: {
  readonly channel: BrandChannel;
  readonly allowFontScaling?: boolean;
}) {
  const { scale } = useAndroidControlSizing();
  const label = BRAND_CHANNEL_LABEL[props.channel];
  if (label === null) return null;

  return (
    <View
      className={
        props.channel === "dev"
          ? "rounded-full bg-channel-dev-surface px-1.5 py-0.5"
          : "rounded-full bg-channel-nightly-surface px-1.5 py-0.5"
      }
      style={
        Platform.OS === "android"
          ? { paddingHorizontal: 5.25 * scale, paddingVertical: 1.75 * scale }
          : undefined
      }
    >
      <Text
        allowFontScaling={props.allowFontScaling}
        className={
          props.channel === "dev"
            ? "font-goat-bold text-channel-dev uppercase"
            : "font-goat-bold text-channel-nightly uppercase"
        }
        style={{ fontSize: 9 * scale, letterSpacing: 0.9 * scale }}
      >
        {label}
      </Text>
    </View>
  );
}
