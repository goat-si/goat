import type { CloudRunCard } from "@goat/client-runtime/state/cloud-task";
import { formatDuration } from "@goat/shared/orchestrationTiming";
import { Alert, Linking, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";

/** The latest cloud run: its current stage while it works, then one result line and actions. */
export function CloudTaskStatus({
  card,
  onRetry,
}: {
  readonly card: CloudRunCard;
  readonly onRetry: (() => void) | null;
}) {
  const openLink = (url: string) => {
    void Linking.openURL(url).catch(() =>
      Alert.alert("Could not open link", "Try opening the task from your browser."),
    );
  };
  const current = card.stages.find((stage) => stage.status === "running");
  const total =
    card.endedAt === null || card.startedAt === null
      ? null
      : Math.max(0, Date.parse(card.endedAt) - Date.parse(card.startedAt));
  const actions = [
    onRetry ? { label: "Retry", onPress: onRetry } : null,
    card.prUrl ? { label: "Open pull request", onPress: () => openLink(card.prUrl!) } : null,
    card.taskUrl
      ? { label: "Open in " + card.provider, onPress: () => openLink(card.taskUrl!) }
      : null,
  ].filter((action) => action !== null);
  return (
    <View accessibilityLabel={card.provider + " run"} className="mx-4 my-2 rounded-lg border p-3">
      <Text accessibilityLiveRegion="polite">
        {card.title}
        {total !== null && Number.isFinite(total) ? " · " + formatDuration(total) : ""}
      </Text>
      {current ? (
        <Text>{current.detail ? current.label + " · " + current.detail : current.label}</Text>
      ) : null}
      {card.message ? (
        <Text accessibilityRole={card.phase === "failed" ? "alert" : undefined}>
          {card.message}
        </Text>
      ) : null}
      {actions.length > 0 ? (
        <View className="mt-1 flex-row flex-wrap gap-4">
          {actions.map((action) => (
            <Pressable
              key={action.label}
              accessibilityRole={action.label === "Retry" ? "button" : "link"}
              accessibilityLabel={action.label}
              onPress={action.onPress}
            >
              <Text>{action.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
