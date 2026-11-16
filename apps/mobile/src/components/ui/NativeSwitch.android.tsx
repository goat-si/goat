import { NativeThemeHost } from "./NativeThemeHost.android";
import { Switch as ComposeSwitch } from "@expo/ui/jetpack-compose";
import { Pressable, View } from "react-native";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import type { ThemedSwitchProps } from "./NativeSwitch.types";

import { useControlTheme } from "./useControlTheme";

// Material's disabled emphasis; left unset, Compose's defaults ignore the switch tokens.
const DISABLED_ALPHA = 0.38;

/** RN Pressable must own touch: Compose-handled switch taps can activate the parent row instead. */
export function NativeSwitch(props: ThemedSwitchProps) {
  const { colors } = useControlTheme();
  const activeTrack = colors["--color-switch-active-track"];
  const activeThumb = colors["--color-switch-active-thumb"];
  const inactiveTrack = colors["--color-switch-inactive-track"];
  const inactiveThumb = colors["--color-switch-inactive-thumb"];
  const dim = (color: string) => themeColorWithAlpha(color, DISABLED_ALPHA);

  return (
    <Pressable
      disabled={props.disabled}
      onPress={() => props.onValueChange?.(!props.value)}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      accessibilityRole="switch"
      accessibilityState={{ checked: Boolean(props.value), disabled: Boolean(props.disabled) }}
      style={props.style}
      testID={props.testID}
    >
      <View importantForAccessibility="no-hide-descendants" pointerEvents="none">
        <NativeThemeHost ignoreSafeAreaKeyboardInsets style={{ width: 52, height: 48 }}>
          <ComposeSwitch
            value={Boolean(props.value)}
            enabled={!props.disabled}
            colors={{
              checkedTrackColor: activeTrack,
              checkedThumbColor: activeThumb,
              checkedBorderColor: activeTrack,
              uncheckedTrackColor: inactiveTrack,
              uncheckedThumbColor: inactiveThumb,
              uncheckedBorderColor: inactiveThumb,
              disabledCheckedTrackColor: dim(activeTrack),
              disabledCheckedThumbColor: dim(activeThumb),
              disabledCheckedBorderColor: "transparent",
              disabledUncheckedTrackColor: dim(inactiveTrack),
              disabledUncheckedThumbColor: dim(inactiveThumb),
              disabledUncheckedBorderColor: dim(inactiveThumb),
            }}
          />
        </NativeThemeHost>
      </View>
    </Pressable>
  );
}
