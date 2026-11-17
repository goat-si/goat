import { formatDiffCount } from "@goat/client-runtime/diff-count";
import type { ThreadCheckpointSummary } from "@goat/client-runtime/state/thread-checkpoints";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

export function TurnDiffStat(props: {
  readonly checkpoint: ThreadCheckpointSummary;
  readonly onOpenTurnDiff: (checkpoint: ThreadCheckpointSummary) => void;
}) {
  const { files } = props.checkpoint;
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const fileCountLabel = `${files.length} file${files.length === 1 ? "" : "s"} changed`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Review ${fileCountLabel}, ${additions} additions, ${deletions} deletions`}
      onPress={() => props.onOpenTurnDiff(props.checkpoint)}
      className="min-h-11 shrink-0 flex-row items-center gap-2 px-2 active:bg-subtle"
    >
      <Text className="font-goat-medium text-xs tabular-nums text-adaptive-emerald-700-300">
        +{formatDiffCount(additions)}
      </Text>
      <Text className="font-goat-medium text-xs tabular-nums text-adaptive-rose-700-300">
        −{formatDiffCount(deletions)}
      </Text>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-foreground-muted" />
    </Pressable>
  );
}
