import { Text, View } from "react-native";

/** An empty bot work panel: what is missing, then the next step, as on web. */
export function MobileBotPanelEmpty(props: { readonly title: string; readonly next: string }) {
  return (
    <View className="gap-0.5 py-2">
      <Text className="font-medium text-foreground">{props.title}</Text>
      <Text className="text-foreground-muted">{props.next}</Text>
    </View>
  );
}
