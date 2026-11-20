import { View } from "react-native";
import { formatDuration } from "@goat/shared/orchestrationTiming";
import { AppText as Text } from "../../components/ui/AppText";
import { useVisibleSecondClock } from "./use-visible-second-clock";

export function RunFoldWorking({
  startedAt,
  minHeight,
}: {
  readonly startedAt: string;
  readonly minHeight: number;
}) {
  const now = useVisibleSecondClock(true);
  const elapsed = Math.max(0, now - Date.parse(startedAt));
  return (
    <View className="min-w-0 flex-1 justify-center" style={{ minHeight }}>
      <Text
        numberOfLines={1}
        className="shrink font-goat-medium text-sm tabular-nums text-foreground-muted"
      >
        Working for {Number.isFinite(elapsed) ? formatDuration(elapsed) : "0s"}
      </Text>
    </View>
  );
}
