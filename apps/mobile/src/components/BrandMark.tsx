import Constants from "expo-constants";
import { Image } from "expo-image";
import { View } from "react-native";

import { AppText as Text } from "./ui/AppText";
import { GOAT_BRAND_MARK_SOURCE } from "./brandAssets";
import { BrandChannelPill } from "./BrandChannelPill";
import { resolveMobileBrandChannel } from "../lib/mobileBranding";

export function BrandMark() {
  const channel = resolveMobileBrandChannel(Constants.expoConfig?.extra?.appVariant);

  return (
    <View className="flex-row items-center gap-3">
      <Image
        source={GOAT_BRAND_MARK_SOURCE}
        accessibilityIgnoresInvertColors
        style={{
          width: 32,
          height: 32,
          borderRadius: 10,
        }}
      />
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <Text
            className="text-lg font-goat-bold text-foreground"
            style={{ letterSpacing: 0.04 * 18 }}
          >
            GOAT
          </Text>
          <BrandChannelPill channel={channel} />
        </View>
      </View>
    </View>
  );
}
