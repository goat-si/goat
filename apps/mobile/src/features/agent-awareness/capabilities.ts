import { isGoatConnectPushEnabled } from "@goat/shared/goatConnect";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { supportsAndroidAgentNotifications } from "./androidNotifications";

export function supportsAgentAwarenessPush() {
  return (
    isGoatConnectPushEnabled() &&
    (Platform.OS === "android"
      ? supportsAndroidAgentNotifications()
      : Platform.OS === "ios" && Constants.expoConfig?.extra?.iosPersonalTeamBuild !== true)
  );
}
