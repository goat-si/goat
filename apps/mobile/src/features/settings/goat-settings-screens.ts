import {
  createNativeStackScreen,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";

import { SettingsDecisionInboxRouteScreen } from "./SettingsDecisionInboxRouteScreen";
import { SettingsGoatBotRouteScreen } from "./SettingsGoatBotRouteScreen";
import { SettingsHubNodesRouteScreen } from "./SettingsHubNodesRouteScreen";
import { SettingsMemoryRouteScreen } from "./SettingsMemoryRouteScreen";

/** GOAT's own Settings pages, spread into Stack.tsx's Settings screens. */
export function goatSettingsScreens<Options extends NativeStackNavigationOptions>(
  pageOptions: Options,
) {
  return {
    SettingsMemory: createNativeStackScreen({
      screen: SettingsMemoryRouteScreen,
      linking: "settings/memory",
      options: { ...pageOptions, title: "Memory" },
    }),
    SettingsGoatBot: createNativeStackScreen({
      screen: SettingsGoatBotRouteScreen,
      linking: "settings/goat-bot",
      options: { ...pageOptions, title: "GOAT Bot" },
    }),
    SettingsHubNodes: createNativeStackScreen({
      screen: SettingsHubNodesRouteScreen,
      linking: "settings/hub-devices",
      options: { ...pageOptions, title: "Hub devices" },
    }),
    SettingsDecisionInbox: createNativeStackScreen({
      screen: SettingsDecisionInboxRouteScreen,
      linking: "settings/decision-inbox",
      options: { ...pageOptions, title: "Decision inbox" },
    }),
  };
}
