import Constants from "expo-constants";
import { Image } from "expo-image";
import { View } from "react-native";

import { AppText as Text } from "./ui/AppText";
import { GOAT_BRAND_MARK_SOURCE } from "./brandAssets";
import { BrandChannelPill } from "./BrandChannelPill";
import { resolveMobileBrandChannel } from "../lib/mobileBranding";

export function BrandMark(props: { readonly compact?: boolean }) {
  const compact = props.compact ?? false;
  const iconSize = compact ? 32 : 44;
  const channel = resolveMobileBrandChannel(Constants.expoConfig?.extra?.appVariant);

  return (
    <View className="flex-row items-center gap-3">
      <Image
        source={GOAT_BRAND_MARK_SOURCE}
        accessibilityIgnoresInvertColors
        style={{
          width: iconSize,
          height: iconSize,
          borderRadius: compact ? 10 : 14,
        }}
      />
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="text-lg font-goat-bold tracking-[-0.4px] text-foreground">GOAT</Text>
          <BrandChannelPill channel={channel} />
        </View>
        {!compact ? (
          <Text className="text-xs font-medium text-foreground-muted">
            Mobile control surface for your live coding environments
          </Text>
        ) : null}
      </View>
    </View>
  );
}
