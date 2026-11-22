import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { MobileBotHomeItem } from "./MobileBotTaskList";

export const sectionLabel = (
  key: string,
  text: string,
  first = false,
  action?: ReactNode,
): MobileBotHomeItem => ({
  key,
  render: () => (
    <View className={`${first ? "mt-2" : "mt-5"} flex-row items-center justify-between`}>
      <Text className="text-xs font-medium text-foreground-muted">{text}</Text>
      {action}
    </View>
  ),
});
export const message = (key: string, node: ReactNode): MobileBotHomeItem => ({
  key,
  render: () => node,
});
